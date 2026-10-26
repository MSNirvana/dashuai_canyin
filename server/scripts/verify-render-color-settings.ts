import { readFile } from 'node:fs/promises'
import { buildColorFilter } from '../src/render/ffmpeg.js'
import {
  RENDER_BEAUTY_SETTINGS,
  RENDER_COLOR_GROUP,
  RENDER_COLOR_SETTINGS,
  validateRenderBeautySetting,
  validateRenderColorSetting,
} from '../src/render/color-settings.js'

let passed = 0
let failed = 0
function check(label: string, condition: boolean): void {
  if (condition) {
    passed++
    console.log(`通过：${label}`)
  } else {
    failed++
    console.error(`失败：${label}`)
  }
}

const [worker, synthesis, admin] = await Promise.all([
  readFile(new URL('../src/render/worker.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/render/synthesis.ts', import.meta.url), 'utf8'),
  readFile(new URL('../src/routes/admin.ts', import.meta.url), 'utf8'),
])

check('调色配置属于 render 分组', RENDER_COLOR_GROUP === 'render')
check('四项调色配置键齐全', RENDER_COLOR_SETTINGS.map((item) => item.key).join(',') === 'color_brightness,color_contrast,color_saturation,color_sharpen')
check('后台调色配置类型和值范围校验生效', validateRenderColorSetting({ groupKey: 'render', settingKey: 'color_brightness', settingVal: '100', valueType: 'INT' }) && !validateRenderColorSetting({ groupKey: 'render', settingKey: 'color_brightness', settingVal: '101', valueType: 'INT' }))
check('后台路由接入调色值校验', admin.includes('validateRenderColorSetting(input)'))
check('AI worker 读取后台调色配置', worker.includes('readRenderColorSettings(prisma)'))
check('AI worker 把调色传入合成', worker.includes('            color,\n'))
check('非 AI 旧链路仍保留任务级调色', worker.includes('if (!aiMode && buildColorFilter(color))'))
check('字幕路径在字幕前应用调色', synthesis.includes("const vf = [colorFilter, subtitleFilter].filter(Boolean).join(',')"))
check('drawtext 路径接入调色节点', synthesis.includes("filters.unshift(`[0:v]${colorFilter}[graded]`)") && synthesis.includes('startNode'))
check('图片叠加路径接入调色节点', synthesis.includes("const filters: string[] = colorFilter ? [`[0:v]${colorFilter}[graded]`] : []"))
check('零值不生成视频调色滤镜', buildColorFilter({ brightness: 0, contrast: 0, saturation: 0, sharpen: 0 }) === null)
check('非零值生成视频调色滤镜', buildColorFilter({ brightness: 10, contrast: 20, saturation: 30, sharpen: 40 }) === 'eq=brightness=0.100:contrast=1.200:saturation=1.300,unsharp=5:5:0.400')

// ── 基本美颜（2026-10-26 新增，与调色同级但独立） ──
check('美颜配置键齐全', RENDER_BEAUTY_SETTINGS.map((item) => item.key).join(',') === 'beauty_smooth')
check(
  '美颜不混进调色四键（否则上面那条顺序断言会红）',
  !RENDER_COLOR_SETTINGS.some((item) => (item.key as string) === 'beauty_smooth'),
)
check(
  '美颜只允许 0~100（负数与越界都拒）',
  validateRenderBeautySetting({ groupKey: 'render', settingKey: 'beauty_smooth', settingVal: '100', valueType: 'INT' }) &&
    !validateRenderBeautySetting({ groupKey: 'render', settingKey: 'beauty_smooth', settingVal: '101', valueType: 'INT' }) &&
    !validateRenderBeautySetting({ groupKey: 'render', settingKey: 'beauty_smooth', settingVal: '-1', valueType: 'INT' }),
)
check('后台路由接入美颜值校验', admin.includes('validateRenderBeautySetting(input)'))
check('磨皮为 0 时不挂滤镜（不增加额外处理）', buildColorFilter({ brightness: 0, contrast: 0, saturation: 0, sharpen: 0, smooth: 0 }) === null)
check(
  '磨皮 100 生成 bilateral 且参数在保守映射上界',
  buildColorFilter({ brightness: 0, contrast: 0, saturation: 0, sharpen: 0, smooth: 100 }) === 'bilateral=sigmaS=10.00:sigmaR=0.300',
)
const mixed = buildColorFilter({ brightness: 10, contrast: 0, saturation: 0, sharpen: 40, smooth: 50 }) ?? ''
check(
  '磨皮排在锐化之前（否则 unsharp 会把刚压掉的毛孔拉回来）',
  mixed.includes('bilateral=sigmaS=6.00:sigmaR=0.160') && mixed.indexOf('bilateral') < mixed.indexOf('unsharp'),
)
const cacheKeys = await readFile(new URL('../src/render/cache-keys.ts', import.meta.url), 'utf8')
check('调色/美颜缓存键纳入 smooth', cacheKeys.includes('color.smooth ?? 0'))
const seed = await readFile(new URL('./seed-render-color.ts', import.meta.url), 'utf8')
check('初始化脚本会创建美颜配置行', seed.includes('RENDER_BEAUTY_SETTINGS'))

console.log(`\n调色配置守护：通过 ${passed} 项，失败 ${failed} 项`)
if (failed) process.exitCode = 1
