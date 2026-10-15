import { readFile } from 'node:fs/promises'
import { buildColorFilter } from '../src/render/ffmpeg.js'
import {
  RENDER_COLOR_GROUP,
  RENDER_COLOR_SETTINGS,
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

console.log(`\n调色配置守护：通过 ${passed} 项，失败 ${failed} 项`)
if (failed) process.exitCode = 1
