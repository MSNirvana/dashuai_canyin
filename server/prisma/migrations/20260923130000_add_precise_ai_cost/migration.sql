-- 精确 AI 成本：避免按 token 分项向上取整造成系统性多扣。
ALTER TABLE `ai_model`
  ADD COLUMN `unit_price_micro_fen` BIGINT NOT NULL DEFAULT 0;

ALTER TABLE `ai_call_log`
  ADD COLUMN `cost_micro_fen` BIGINT NOT NULL DEFAULT 0;
