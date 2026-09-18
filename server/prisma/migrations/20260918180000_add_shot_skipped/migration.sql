-- 「暂不上传该分镜」的**服务端**落点。
--
-- 背景：这个动作原先只写在小程序页面的 state 里（`_skipped: true`），
-- 而合成页是按「分镜有没有 assetId」判断素材是否齐全的 ⇒ 跳过一刷新就丢，
-- 用户被永久挡在合成页外（提示「请先补齐全部分镜素材」，但那个分镜他本来就打算不拍）。
--
-- 不变量：`skipped = 1` 的分镜，`asset_id` 必须为 NULL（两者互斥，由 updateShotAsset 维持）。
-- 存量数据全部为 0（没有任何分镜被标记过跳过）。
ALTER TABLE `shot`
  ADD COLUMN `skipped` BOOLEAN NOT NULL DEFAULT false AFTER `trim_end_ms`;
