-- 赠豆分桶：把「注册赠豆」从「会员周期赠豆」里拆出来。
--
-- 背景：bean_account 只有一个 grant_balance，注册赠豆（auth.service 新用户一次性发 30）与
-- 会员赠豆（买会员送，到期清零）都往这里进，而 bean.service.grant() 把 bizType 硬编码成
-- 'MEMBERSHIP'，账务上完全无法区分来源。
--
-- 后果：会员到期时 expireGrant() 清空整个 grant_balance，会把注册赠豆一起清掉 ——
-- 拉新时承诺「送 30 豆试用」，却在 30 天后随会员一起作废。
--
-- 为什么必须靠加桶而不是改清零算法：消耗是**池化**的（grant 桶整体扣减，没有批次概念），
-- 所以「账上还剩多少注册赠豆」无法从历史流水反推。只有独立成桶才能精确表达。
--
-- 消耗顺序（对用户有利，先用会作废的）：
--   会员赠豆 grant_balance → 注册赠豆 grant_register_balance → 充值豆 balance
--
-- 不做事后回填：生产库尚未部署（无历史数据）；本机开发库的测试账户由验证脚本自行重置。
-- 若将来需要对已有数据拆分，唯一可精确判断的子集是 total_consume = 0（从未消耗过）的账户 ——
-- 此时注册赠豆必然原封不动（因为消耗顺序上它在会员赠豆之后）。
ALTER TABLE `bean_account`
  ADD COLUMN `grant_register_balance` BIGINT NOT NULL DEFAULT 0;

ALTER TABLE `bean_ledger`
  ADD COLUMN `grant_register_amount` BIGINT NOT NULL DEFAULT 0;
