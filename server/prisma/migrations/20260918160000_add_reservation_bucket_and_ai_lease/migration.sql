-- ① 预留记录来源桶（见 schema.prisma BeanReservation.grantReserved 的注释）。
--    存量行保留 grant_reserved=0 / grant_register_reserved=0 / membership_id=NULL：
--    语义等价于「这次预留全部来自充值积分」，于是到期清零不会为它们保留任何额度 ——
--    与改动前的行为一致，不会让历史数据凭空多出可用余额。
ALTER TABLE `bean_reservation` ADD COLUMN `grant_reserved` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `grant_register_reserved` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `membership_id` BIGINT UNSIGNED NULL;

-- ② AI 业务请求租约（见 schema.prisma BusinessRequest.leaseOwner 的注释）。
--    存量 PENDING 行 lease_expire_at=NULL ⇒ 视为「无主」，恢复扫描会立即认领它们。
ALTER TABLE `business_request` ADD COLUMN `lease_owner` VARCHAR(64) NULL,
    ADD COLUMN `lease_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
    ADD COLUMN `lease_expire_at` DATETIME(3) NULL;

CREATE INDEX `business_request_status_lease_expire_at_idx` ON `business_request`(`status`, `lease_expire_at`);
