-- 支付风控缺口：补上「扣款成功但开通失败」的检测与告警通路。
--
-- 背景（为什么支付一放开就必须有这张表）：
--   支付放开之前，「会员」只能由后台手动开通（adminActivateMembership），每一笔都有人在场；
--   PAYMENTS_ENABLED=true 之后，会员与加油包都走线上收款 —— 钱到没到、货发没发，
--   全靠一条链路自己可靠，而这条链路的**失败是静默的**：
--     · 微信回调不是可靠通道（notify_url 不可达 / 网络抖动 / 重试耗尽都会丢）
--     · 低频对账 sweeper 只看**最近 48 小时**的 PENDING 单 ⇒ 超窗口后**再没有人看它**
--     · 金额不一致、微信侧已退款、关单失败这些分支原本只有一行 console.error
--   代码里到处写着「没有任何告警」（pay-reconcile / wxpay / orders 的文件头都在叹气），
--   这次把这句话兑现。
--
-- 两张表分工：
--   order_settlement  = 事实层。「订单已 PAID」的**唯一凭据**，与终态 CAS 在**同一事务**内写入。
--                       它让 `PAID ⇒ 权益已发` 从一句注释变成一条机器可验证的不变量。
--   ops_alert         = 触达层。所有只能靠人发现的异常的唯一出口（落库 + 推送 + 可标记已处理）。

-- ──────────────────────── order_settlement ────────────────────────
--
-- ★ 为什么不复用权益表反推「到底发没发」：
--   `markOrderPaid()` 已把 CAS 与发权益放进同一事务，所以今天 `PAID ⇒ 已发` 成立；
--   但没有证据，将来任何人在事务外补一句 `order.update({status:'PAID'})`（或手工改库）
--   都会造成「钱收了、货没发」，而且**我们完全不会知道**。
--   靠权益表反推则有**两处确定的误报**：
--     · MEMBER 续期时 `Membership.sourceOrderId` 仍指向**上一张**订单；
--     · `grantPoints = 0` 时 `grant()` 根本不会被调用，于是「没有流水」既可能是没发、
--       也可能是本就该发 0，无法区分。
--   回执在事务内写 ⇒ 存在 ⟺ 事务提交 ⟺ 权益已发，判据唯一、无需启发式。
--
-- ★ `order_id` 上唯一索引 = 幂等锚点。终态 CAS 保证一张单只结算一次，
--   所以同订单重复写回执会撞唯一键 —— 这正好是我们要的「不可能发生」的表达。
--
-- 存量数据：**不回填**。历史上「后台手动开通」的单（A 前缀）没有回执，
--   而它们都经过了同一个事务 ⇒ 回执核对只对**上线之后**的单生效，
--   核对查询带有 `createdAt >= 上线时间` 的窗口（见 pay-risk.service.ts），
--   否则会把整段历史刷成假警。这里一行都不改，迁移对存量零影响。
CREATE TABLE `order_settlement` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `order_id` BIGINT UNSIGNED NOT NULL,
    `order_no` VARCHAR(64) NOT NULL,
    `merchant_id` BIGINT UNSIGNED NOT NULL,
    `order_type` VARCHAR(24) NOT NULL,
    `amount_fen` INTEGER UNSIGNED NOT NULL,
    `granted_beans` BIGINT NOT NULL DEFAULT 0,
    `membership_end_at` DATETIME(3) NULL,
    `source` VARCHAR(24) NOT NULL,
    `wx_transaction_id` VARCHAR(128) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `order_settlement_order_id_key`(`order_id`),
    INDEX `order_settlement_merchant_id_created_at_idx`(`merchant_id`, `created_at`),
    INDEX `order_settlement_order_type_created_at_idx`(`order_type`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ──────────────────────── ops_alert ────────────────────────
--
-- ★ 为什么不只推 webhook：webhook 会失败、会被忽略、会被撤回，
--   而这一类事件每一笔都是真金白银，必须能事后逐笔查证、能标记已处理、能看见处理人。
--   推送只是触达手段，落库才是事实。所以「未配置推送渠道」时告警**依然成立**（push_status=SKIPPED）。
--
-- ★ 去重口径：同一 `dedupe_key` 在去重窗口内重复触发只累加 `occurrences` 并刷新 `last_seen_at`，
--   **不新增行、不重复推送**。这是必须的 —— 对账 sweeper 每 5 分钟跑一轮，
--   一个持久故障若每轮都推一次，运营两小时后就再也不看告警了。
--   已 ack 的键再次出现会新开一条（问题复发必须重新提醒）。
--
-- ★ 刻意**不建外键**：告警必须能在任何数据状态下写入成功。
--   若为一行已被清理的订单建了 FK，告警本身就会写失败 —— 恰恰在最需要它的时刻。
--
-- 存量数据：新表，无存量。
CREATE TABLE `ops_alert` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `code` VARCHAR(48) NOT NULL,
    `severity` VARCHAR(16) NOT NULL DEFAULT 'WARN',
    `title` VARCHAR(200) NOT NULL,
    `detail` TEXT NULL,
    `ref_type` VARCHAR(32) NULL,
    `ref_id` VARCHAR(64) NULL,
    `dedupe_key` VARCHAR(160) NOT NULL,
    `occurrences` INTEGER NOT NULL DEFAULT 1,
    `first_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `last_seen_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `push_status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    `push_error` VARCHAR(500) NULL,
    `acked_at` DATETIME(3) NULL,
    `acked_by` BIGINT UNSIGNED NULL,
    `ack_note` VARCHAR(255) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    INDEX `ops_alert_dedupe_key_acked_at_last_seen_at_idx`(`dedupe_key`, `acked_at`, `last_seen_at`),
    INDEX `ops_alert_acked_at_created_at_idx`(`acked_at`, `created_at`),
    INDEX `ops_alert_code_last_seen_at_idx`(`code`, `last_seen_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
