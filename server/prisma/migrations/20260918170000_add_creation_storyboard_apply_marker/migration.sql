-- 「AI 分镜结果首次应用」标记（见 schema.prisma Creation.storyboardAppliedRequestId 的注释）。
--
-- 存量行两列均为 NULL：语义是「从来没有记录过应用状态」，于是下一次生成/重放会
-- 正常地建立标记并重建分镜 —— 与改动前的行为一致，不会因为加列而跳过任何一次应用。
ALTER TABLE `creation` ADD COLUMN `storyboard_applied_request_id` VARCHAR(64) NULL,
    ADD COLUMN `storyboard_applied_at` DATETIME(3) NULL;
