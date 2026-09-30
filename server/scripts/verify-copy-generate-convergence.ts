/**
 * copy_generate 收敛契约：通用场景只保留内部兼容/历史用途。
 *
 * 纯源码验证，不连接数据库、不调用 AI、不修改账本或历史数据。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { SCENE } from '../src/ai/scene-codes.js'
import { COPY_TRACKS, DEFAULT_COPY_TRACK, resolveCopySceneForVerification } from '../src/services/creation.service.js'

let pass = 0
let fail = 0
function check(ok: boolean, label: string) {
  if (ok) {
    pass++
    console.log(`  ✓ ${label}`)
  } else {
    fail++
    console.log(`  ✗ ${label}`)
  }
}
function read(rel: string) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8')
}

const miniCreationSrc = read('../../apps/mini/src/services/creation.ts')
check(!miniCreationSrc.includes("value: 'copy_generate'"), '小程序正常款式选项不暴露 copy_generate')
check(!Object.values(COPY_TRACKS).some((item) => (item.scene as string) === SCENE.copy_generate), '服务端正常款式映射不使用 copy_generate')
check(DEFAULT_COPY_TRACK === 'PRODUCT', '当前明确默认款式仍为 PRODUCT')
check(SCENE.copy_generate === 'copy_generate', 'copy_generate 场景常量仍保留，旧账本/日志标识不变')

const creationSrc = read('../src/services/creation.service.ts')
check(creationSrc.includes('copy_generate` 只保留给旧客户端直接 scene 请求与历史账本/日志使用'), '服务端明确标注 copy_generate 仅内部兼容/历史用途')
check(!/return hit \? scene : SCENE_COPY/.test(creationSrc), '缺失款式场景不再直接回退 copy_generate')
check(
  creationSrc.includes('const fallbackScene = resolveCopySceneForVerification(track)') &&
    creationSrc.includes('where: { code: fallbackScene, enabled: true }'),
  '缺失款式场景回退当前默认款式',
)

const adminSrc = read('../../apps/admin/src/pages/AiCallLogs.tsx')
check(adminSrc.includes('通用文案（内部兼容/历史）'), '后台历史日志筛选标签明确为内部兼容/历史')

const directSceneSrc = read('../src/ai/ai.service.ts')
check(directSceneSrc.includes('params.sceneCode'), '底层 runBilledScene 仍按调用方直接 sceneCode 处理，旧客户端兼容入口未删除')

const defaultScene = resolveCopySceneForVerification('PRODUCT')
check(defaultScene === SCENE.copy_product, '验证默认款式 PRODUCT 对应 copy_product')
const missingScene = resolveCopySceneForVerification('PERSONA')
check(missingScene === SCENE.copy_product, '验证款式场景缺失时回退 copy_product，而不是 copy_generate')

console.log(`\n通过 ${pass} 项，失败 ${fail} 项`)
if (fail > 0) process.exitCode = 1
