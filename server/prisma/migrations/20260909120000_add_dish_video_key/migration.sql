-- 菜品视频字段：用于菜品详情/创作素材关联的可选 COS Key
ALTER TABLE `dish` ADD COLUMN `video_key` VARCHAR(512) NULL AFTER `cover_key`;
