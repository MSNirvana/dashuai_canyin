-- AI 计费：记录「被场景单次上限截断、由平台承担」的豆数。
--
-- 背景：ai_scene.bean_price 的语义是「单次冻结上限（财务安全网）」，实际扣费按
-- 成本 × 系数计算且不超过该上限，超出部分由平台承担 —— 这个设计本身没问题。
--
-- 问题在于缺少可观测性：日志里只有 cost_fen（成本）和 bean_charged（实收），
-- 看不出上限到底有没有生效。实测本机数据（seed 默认值，成本×4×100豆/元）：
--   copy_intro      成本 2 分 → 应付 8 豆 → 上限 5 → 实收 5 → 每次贴 3 豆，10/10 次全中
--   copy_traffic    同上
--   storyboard      成本 2 分 → 应付 8 豆 → 上限 10 → 实收 8 → 未截断
-- 也就是说 copy 系场景的上限**不是安全网，而是在每一次正常调用上都生效**，
-- 变成 100% 的常态折扣 —— 但账上和日志上完全看不出来。
--
-- 本列让「平台补贴」可审计：absorbed_beans = 应付 − 实收。
-- 是否要把上限调高（等于给用户涨价）属于商业决策，不在本次改动范围内。
ALTER TABLE `ai_call_log`
  ADD COLUMN `absorbed_beans` BIGINT NOT NULL DEFAULT 0;

-- 便于运营按场景看累计补贴
CREATE INDEX `ai_call_log_scene_created_at_idx` ON `ai_call_log` (`scene_code`, `created_at`);
