-- AI 通道「真实故障证据」：把请求路径上的连续失败累计到通道行上。
--
-- 背景（2026-09-23 生产问题）：用户问「后台不是有不间断的模型测试吗？deepseek 不可用
-- 应该自动降级啊，别下次轮到别的模型出错又白等」。核对线上库后发现四套机制都治不了「慢」：
--
--   ① 请求路径熔断（circuit-breaker.ts）：TIMEOUT 属通道级硬故障 ⇒ 会 `open()`，
--      但标记**只在 Redis**、`EX 300`（5 分钟）⇒ 5 分钟后自动遗忘，低频场景等于没有。
--   ② 失败率熔断（`record()`）：要求滑动窗口内 ≥ minSamples(20) 个样本。AI 调用是低频的，
--      几小时都攒不满 20 个 ⇒ 这条路径事实上从未生效过（线上 `circuit_open_until` 全为 NULL）。
--   ③ 健康体检（ai-health.service.ts）：判据是「24h 内有真实成功 ⇒ 免探测」，而且
--      **证据是通道级、不是场景级**（`distinct providerId`）⇒ 通道在任一场景成功过，
--      所有场景都免检。实测：deepseek 03:08 在 copy_product 成功 8.6s ⇒ 03:11 在
--      storyboard_generate 上思考跑飞触发 150s 超时，体检**完全看不到**。
--   ④ `circuit_open_until` 这一列：全代码**只有读、没有任何写入点** ⇒ 恒为 NULL，
--      后台「AI 通道」页看起来「什么都没发生过」。
--
-- 本迁移提供「连续失败」这个更强的真实证据，使体检可以据此降级一个**在别处成功过、
-- 但在某一个场景上反复干不了活**的通道。
--
-- ★ 为什么是「计数列」而不是「往 ai_call_log 里加失败行」：
--   `ai_call_log` 上有 `@@unique([merchantId, sceneCode, requestId])`。
--   同一个业务 requestId 在一条候选链上会失败多次（每个候选一次、每次重试一次），
--   写失败行必然撞这个唯一索引；而放宽它（改 key / 给 requestId 加后缀）会破坏
--   `ai.service.ts` 里「按 (merchantId, sceneCode, requestId) 取回上次结果」的重放语义 ——
--   那条路径一旦取到一条失败行，就会把空 responseSnapshot 当成功结果返回**并且照常结算扣费**。
--   ⇒ 失败信号放在通道行上，副作用最小、语义最直白，也不必触碰计费链路。
--
-- ★ 存量数据：一律 `consecutive_failures = 0` / 其余 NULL（默认值兜住）。
--   语义恰好正确：在此之前系统里没有任何失败计数，所有通道都应当从「零连续失败」开始。
ALTER TABLE `ai_provider`
  ADD COLUMN `consecutive_failures` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `last_failure_at` DATETIME(3) NULL,
  ADD COLUMN `last_failure_code` VARCHAR(64) NULL,
  ADD COLUMN `last_failure_msg` VARCHAR(500) NULL;
