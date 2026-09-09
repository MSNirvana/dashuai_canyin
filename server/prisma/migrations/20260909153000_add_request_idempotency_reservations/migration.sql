-- P0: tenant-scoped business idempotency and per-operation bean reservations.
CREATE TABLE `bean_reservation` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `merchant_id` BIGINT UNSIGNED NOT NULL,
  `biz_type` VARCHAR(32) NOT NULL,
  `biz_id` VARCHAR(64) NOT NULL,
  `request_id` VARCHAR(64) NOT NULL,
  `reserved` BIGINT NOT NULL DEFAULT 0,
  `consumed` BIGINT NOT NULL DEFAULT 0,
  `released` BIGINT NOT NULL DEFAULT 0,
  `status` VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `bean_reservation_merchant_id_biz_type_request_id_key` (`merchant_id`, `biz_type`, `request_id`),
  KEY `bean_reservation_merchant_id_biz_type_biz_id_idx` (`merchant_id`, `biz_type`, `biz_id`),
  KEY `bean_reservation_status_updated_at_idx` (`status`, `updated_at`),
  CONSTRAINT `bean_reservation_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchant` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `business_request` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `merchant_id` BIGINT UNSIGNED NOT NULL,
  `operation` VARCHAR(32) NOT NULL,
  `request_id` VARCHAR(64) NOT NULL,
  `payload_hash` CHAR(64) NOT NULL,
  `resource_type` VARCHAR(32) NULL,
  `resource_id` BIGINT UNSIGNED NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  `result_ref` VARCHAR(255) NULL,
  `error_code` VARCHAR(64) NULL,
  `error_msg` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `business_request_merchant_id_operation_request_id_key` (`merchant_id`, `operation`, `request_id`),
  KEY `business_request_merchant_id_operation_created_at_idx` (`merchant_id`, `operation`, `created_at`),
  KEY `business_request_status_updated_at_idx` (`status`, `updated_at`),
  CONSTRAINT `business_request_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchant` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `render_task`
  ADD COLUMN `reservation_id` BIGINT UNSIGNED NULL,
  ADD INDEX `render_task_reservation_id_fkey` (`reservation_id`),
  ADD CONSTRAINT `render_task_reservation_id_fkey` FOREIGN KEY (`reservation_id`) REFERENCES `bean_reservation` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Existing installations may contain provider test rows with NULL merchant_id;
-- MySQL permits multiple NULLs in this unique key while tenant rows are scoped.
ALTER TABLE `ai_call_log`
  DROP INDEX `ai_call_log_request_id_key`,
  ADD UNIQUE KEY `ai_call_log_merchant_id_scene_code_request_id_key` (`merchant_id`, `scene_code`, `request_id`);

ALTER TABLE `bean_ledger`
  DROP INDEX `bean_ledger_request_id_type_key`,
  ADD UNIQUE KEY `bean_ledger_merchant_id_biz_type_request_id_type_key` (`merchant_id`, `biz_type`, `request_id`, `type`);
