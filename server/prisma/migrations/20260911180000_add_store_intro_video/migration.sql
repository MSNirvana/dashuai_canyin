-- 门店增加「门店介绍」与「门店视频」两个可选字段
-- intro：门店详情页统一展示的一句话/多句话介绍
-- video_key：门店环境或招牌短视频的对象键，仅用于门店展示，不进创作素材池
ALTER TABLE `store`
  ADD COLUMN `intro` VARCHAR(500) NULL AFTER `cover_key`,
  ADD COLUMN `video_key` VARCHAR(512) NULL AFTER `intro`;
