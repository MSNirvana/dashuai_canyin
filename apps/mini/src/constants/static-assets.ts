// ★ 本文件由 `npm run assets:upload` 生成，请勿手改。
// 生成时间依据：每次上传会重写，内容只取决于 server/.env 里的桶/区域与文件名。
//
// 为什么这些图不放在 src/assets 里：
//   它们是纯展示图，不需要跟版本走。放进代码包会同时踩两条微信「代码质量」红线 ——
//   包内图片合计超过 200K（建议项），以及白占 2MB 主包上限的额度。
//
// ⚠ 这些对象是**匿名可读**（putObject 时设了 ACL: public-read），
//   因为服务端媒资那套签名 URL 只有 1 小时有效期，不适合做静态资源。
//
// ⚠ 真机/体验版/正式版要把域名加进小程序后台的「downloadFile 合法域名」，
//   否则 image 组件会被静默拦掉（开发者工具里勾了"不校验合法域名"看不出来）。
export const STATIC_BASE_URL = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com'

/** static/mini/home/create-hero.jpg */
export const HOME_CREATE_HERO = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/create-hero.jpg'

/** static/mini/home/work-food.jpg */
export const HOME_WORK_FOOD = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/work-food.jpg'

/** static/mini/home/work-education.jpg */
export const HOME_WORK_EDUCATION = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/work-education.jpg'

/** static/mini/home/work-beauty.jpg */
export const HOME_WORK_BEAUTY = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/work-beauty.jpg'

/** static/mini/home/work-service.jpg */
export const HOME_WORK_SERVICE = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/work-service.jpg'

/** static/mini/home/work-leisure.jpg */
export const HOME_WORK_LEISURE = 'https://dashuai-1485028436.cos.ap-beijing.myqcloud.com/static/mini/home/work-leisure.jpg'
