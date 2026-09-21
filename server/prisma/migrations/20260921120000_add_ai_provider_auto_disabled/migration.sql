-- AI 通道健康体检：区分「sweeper 自动停用」与「运营手动停用」。
--
-- 背景：新增一个 30 分钟一轮的常驻探活 job（`src/ai/ai-health.service.ts`），
-- 探测失败的通道会被置 `enabled = 0` 停用，探测恢复后自动打开。
--
-- ★ 为什么必须单独加一列，而不是复用已有的 `enabled` / `health_status`：
--   1. 只靠 `enabled = 0` 无法区分「谁关的」。运营手动停用（成本太高 / 已废弃 / 换供应商）
--      必须是**永久**的，而 sweeper 的停用必须**可自动恢复**。两者混在一个布尔位上，
--      sweeper 一定会在某个凌晨把运营故意关掉的通道重新打开；反过来它也可能永远
--      不再探活一个其实已经恢复的通道。⇒ 用 `auto_disabled` 表达「这行的开/关归 sweeper 管」。
--   2. 用 `health_status` 当标记会污染该列的语义（它是**健康状态**，不是**归属**），
--      而且网关在每次成功调用后都会把它写回 'HEALTHY'（gateway.ts 的成功分支），
--      标记会被静默抹掉。
--
-- ★ 与网关的关系（为什么 auto_disabled 行不会「自己活过来」）：
--   gateway.ts 的候选跳过里有一条 `if (!provider.enabled || provider.healthStatus === 'DOWN') continue`
--   ⇒ 被自动停用的通道在**请求路径**上确实不再被使用（这是我们要的），
--   但这也意味着**它再也不会被请求路径探到**。所以 sweeper 必须自己按
--   `enabled = 1 OR auto_disabled = 1` 去扫，而不是只看 enabled=1。
--
-- 存量数据：一律 `auto_disabled = 0`（默认值兜住）。
--   语义上恰好正确 —— 现在库里所有 `enabled = 0` 的行都是运营手动关的（含 mock-local），
--   这次迁移不会让任何一行被 sweeper 接管，也不会改变任何一行已有数据的语义。
ALTER TABLE `ai_provider` ADD COLUMN `auto_disabled` BOOLEAN NOT NULL DEFAULT false;

-- 体检扫描的候选集就是 `enabled = 1 OR auto_disabled = 1`，给它一个可用的索引。
-- 已有的 `ai_provider_enabled_priority_idx` 只覆盖 enabled 单列前缀，帮不到 OR 的第二个分支。
CREATE INDEX `ai_provider_auto_disabled_idx` ON `ai_provider`(`auto_disabled`);
