-- 分镜增加「景别」字段：远景 / 全景 / 中景 / 近景 / 特写 / 大特写
-- 与 shot_type（镜头分类：开场/口播/特写/原料/制作/环境/试吃/卖点/收尾）配合使用

ALTER TABLE `shot`
  ADD COLUMN `shot_size` VARCHAR(16) NULL AFTER `shot_type`;
