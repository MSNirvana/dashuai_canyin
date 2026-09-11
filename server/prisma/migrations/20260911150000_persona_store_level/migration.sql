-- 人设门店化：一门店一条人设（内容层级：门店 > 菜品/创作/人设）
-- 历史数据迁移：每家商家现有人设挂到其最早创建的门店；无门店商家的人设删除。

ALTER TABLE `persona`
  ADD COLUMN `store_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 AFTER `merchant_id`;

-- 迁移：挂到商家最早创建的未删除门店
UPDATE `persona` p
JOIN (
  SELECT merchant_id, MIN(id) AS first_store_id
  FROM `store`
  WHERE deleted_at IS NULL
  GROUP BY merchant_id
) s ON p.merchant_id = s.merchant_id
SET p.store_id = s.first_store_id;

-- 无门店商家的人设（孤儿数据）删除
DELETE FROM `persona` WHERE `store_id` = 0;

ALTER TABLE `persona`
  ADD UNIQUE KEY `persona_store_id_key` (`store_id`),
  ADD CONSTRAINT `persona_store_id_fkey` FOREIGN KEY (`store_id`) REFERENCES `store` (`id`);

-- merchant_id 的 unique 键被外键依赖：先建普通索引再删 unique（一商家可多门店各一条人设）
ALTER TABLE `persona`
  ADD INDEX `persona_merchant_id_idx` (`merchant_id`);

ALTER TABLE `persona`
  DROP KEY `persona_merchant_id_key`;
