-- 首页「优秀作品」：独立运营内容表
-- 刻意不与 render_task / creation 关联成外键：作品是运营内容，商家的创作被删不应影响首页展示
-- recipe_json 是核心字段：「生成同款」把它预填进创作流（赛道 / 复杂度 / 标题 / 分镜骨架）

CREATE TABLE `excellent_work` (
  `id`              BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `title`           VARCHAR(128) NOT NULL,
  `category`        VARCHAR(32) NOT NULL,
  `sub_category`    VARCHAR(32) NULL,
  `tags`            JSON NULL,
  `cover_key`       VARCHAR(512) NULL,
  `video_key`       VARCHAR(512) NULL,
  `duration_ms`     INT UNSIGNED NULL,
  `recipe_json`     JSON NOT NULL,
  `sort`            INT NOT NULL DEFAULT 0,
  `enabled`         BOOLEAN NOT NULL DEFAULT true,
  `source_type`     VARCHAR(16) NOT NULL DEFAULT 'MANUAL',
  `source_task_id`  BIGINT UNSIGNED NULL,
  `view_count`      INT UNSIGNED NOT NULL DEFAULT 0,
  `clone_count`     INT UNSIGNED NOT NULL DEFAULT 0,
  `published_at`    DATETIME(3) NULL,
  `created_at`      DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at`      DATETIME(3) NOT NULL,
  `deleted_at`      DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  INDEX `excellent_work_category_enabled_sort_idx` (`category`, `enabled`, `sort`),
  INDEX `excellent_work_enabled_sort_idx` (`enabled`, `sort`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
