-- worker 租约（fencing token）：见 schema.prisma RenderTask.leaseOwner 的注释。
-- 存量行 lease_version=0 / lease_owner=NULL / lease_expire_at=NULL，
-- 语义上等价于「当前没有执行者持锁」，回收扫描会按「RUNNING 且租约为空或已过期」兜住它们。
ALTER TABLE `render_task` ADD COLUMN `lease_expire_at` DATETIME(3) NULL,
    ADD COLUMN `lease_owner` VARCHAR(64) NULL,
    ADD COLUMN `lease_version` INTEGER UNSIGNED NOT NULL DEFAULT 0;

CREATE INDEX `render_task_status_lease_expire_at_idx` ON `render_task`(`status`, `lease_expire_at`);
