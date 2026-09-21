-- 发布素材：把「成片」变成「能直接发出去的一条内容」需要的三样东西（标题 / 封面 / 文案）。
--
-- 背景：成片只在自家小程序里能看，商户还得自己另想标题、另找封面、另写文案。
--   这一步把这些一次生成出来，绑定在**创作**上（产品口径：每个创作一份）。
--
-- ★ 为什么是独立表而不是给 creation 加几列：
--   封面键 + 提示词 + 实际像素 + 模型码，再加后续可能的「话题标签 / 多张封面备选」，
--   会把 creation 主表撑宽，而这些字段与创作本身（分镜 / 素材 / 成片）的语义无关。
--   另起一张表也让「重新生成 = 覆盖」成为一个明确的 upsert（creation_id 唯一键）。
--
-- ★ cover_key 的存法与生命周期（这是本表最容易踩的两个坑）：
--   1. 前缀必须落在既有白名单内。本项目新增对象前缀要同步 5 处
--      （local-storage.ts 的 ALLOWED_PREFIXES / GC 扫描前缀 / GC 删除白名单 /
--        collectReferencedKeys() / 签名守卫），所以这里刻意复用 `uploads/{merchantId}/…`，
--      不新增前缀 —— 少改 5 处就少 5 个静默失效点。
--   2. 必须登记进 scripts/gc-orphan-objects.ts 的 collectReferencedKeys()，
--      否则保留期（默认 24h）一到，封面会被当孤儿对象删掉，而库里那行还在
--      —— 表现为「素材页有封面、点开是一片白」。
--
-- ★ 存量数据：本表新建，无存量。ai_scene.kind 加列对已有场景是纯加列
--   （默认 'TEXT'，与现状语义完全一致：全部场景都走 chat/completions）。
ALTER TABLE `ai_scene` ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'TEXT';

CREATE TABLE `creation_publish_material` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `creation_id` BIGINT UNSIGNED NOT NULL,
    `merchant_id` BIGINT UNSIGNED NOT NULL,
    `title` VARCHAR(120) NOT NULL,
    `caption` TEXT NOT NULL,
    `cover_key` VARCHAR(512) NULL,
    `cover_prompt` TEXT NULL,
    `cover_width` INTEGER UNSIGNED NULL,
    `cover_height` INTEGER UNSIGNED NULL,
    `model_code` VARCHAR(128) NULL,
    `request_id` VARCHAR(64) NULL,
    `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updated_at` DATETIME(3) NOT NULL,

    UNIQUE INDEX `creation_publish_material_creation_id_key`(`creation_id`),
    INDEX `creation_publish_material_merchant_id_created_at_idx`(`merchant_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
-- 用 RESTRICT 而不是 CASCADE：与 Prisma 对「必填关系」的默认一致（不写 onDelete 就是 Restrict），
-- 否则 schema 与库会长期漂移（下次 migrate dev 会跳出来要求改成 CASCADE）。
-- 而且创作本身是软删除（deletedAt），真删整条创作时宁可让删除失败、也不该静默带走发布素材。
ALTER TABLE `creation_publish_material` ADD CONSTRAINT `creation_publish_material_creation_id_fkey` FOREIGN KEY (`creation_id`) REFERENCES `creation`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `creation_publish_material` ADD CONSTRAINT `creation_publish_material_merchant_id_fkey` FOREIGN KEY (`merchant_id`) REFERENCES `merchant`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
