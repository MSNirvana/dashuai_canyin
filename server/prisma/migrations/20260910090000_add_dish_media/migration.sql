CREATE TABLE `dish_media` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `dish_id` BIGINT UNSIGNED NOT NULL,
  `type` VARCHAR(16) NOT NULL,
  `cos_key` VARCHAR(512) NOT NULL,
  `cover_key` VARCHAR(512) NULL,
  `sort` INT NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `dish_media_dish_id_type_sort_idx` (`dish_id`, `type`, `sort`),
  CONSTRAINT `dish_media_dish_id_fkey` FOREIGN KEY (`dish_id`) REFERENCES `dish` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
