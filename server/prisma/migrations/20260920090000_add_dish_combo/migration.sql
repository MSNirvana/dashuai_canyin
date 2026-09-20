-- 菜品库从「只有单菜」扩展到「单菜 + 套餐」。
--
-- ① dish 加 kind / price_fen / original_price_fen
--    ★ 复用同一张表而不是新建 combo 表，是为了让 Creation.dish_id 继续有效：
--      「创作时选一个套餐」= 选一条 dish，于是 AI 变量 dishName 自动就是套餐名，
--      「套餐喂给 AI」这件事在数据层不用改任何结构。
--    ★ price_fen 单位是**分**（与 member_package.price_fen / order.amount_fen 同口径），
--      不用浮点：`0.1 + 0.2 !== 0.3` 这类误差不该出现在钱上。
-- ② dish_combo_item 描述「套餐由哪些单菜组成」，两个外键都 ON DELETE CASCADE：
--    硬删一道菜时，引用它的套餐明细跟着收敛，不会留下悬空 dish_id。
--    软删（deleted_at）不触发级联，明细照旧保留 —— 恢复时结构还在。
--
-- 存量数据：全部自动成为 kind='SINGLE' 且两个价格列为 NULL（默认值兜住），
-- 也就是这次迁移对已有菜品是**纯加列**，不改变任何一行已有数据的语义。
ALTER TABLE `dish` ADD COLUMN `kind` VARCHAR(16) NOT NULL DEFAULT 'SINGLE',
    ADD COLUMN `original_price_fen` INTEGER UNSIGNED NULL,
    ADD COLUMN `price_fen` INTEGER UNSIGNED NULL;

-- CreateTable
CREATE TABLE `dish_combo_item` (
    `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    `combo_id` BIGINT UNSIGNED NOT NULL,
    `dish_id` BIGINT UNSIGNED NOT NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `sort` INTEGER NOT NULL DEFAULT 0,

    INDEX `dish_combo_item_dish_id_idx`(`dish_id`),
    UNIQUE INDEX `dish_combo_item_combo_id_dish_id_key`(`combo_id`, `dish_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `dish_combo_item` ADD CONSTRAINT `dish_combo_item_combo_id_fkey` FOREIGN KEY (`combo_id`) REFERENCES `dish`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `dish_combo_item` ADD CONSTRAINT `dish_combo_item_dish_id_fkey` FOREIGN KEY (`dish_id`) REFERENCES `dish`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
