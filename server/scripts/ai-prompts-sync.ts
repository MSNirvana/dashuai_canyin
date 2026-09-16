// 把 prisma/prompts.ts 的提示词模板同步进 ai_scene 表。
//
// 只更新 name / promptTemplate / fallbackTemplate / temperature ——
// beanPrice、defaultModelId、fallbackModelIds、timeoutMs、enabled 都算运营配置，
// 后台改过就该保留。跑 npm run db:seed 会把它们连同模板一起打回默认值，
// 所以改模板要用这个脚本，而不是 seed。
//
// 用法：npm run ai-prompts:sync
import { PrismaClient } from '@prisma/client'
import { CREATION_SCENE_PROMPTS, STORYBOARD_SCENE } from '../prisma/prompts.js'
import { validateTemplate } from '../src/ai/prompt-vars.js'

const prisma = new PrismaClient()

async function main() {
  const scenes = [...CREATION_SCENE_PROMPTS, STORYBOARD_SCENE]
  let synced = 0
  const problems: string[] = []

  for (const s of scenes) {
    // 同步前按变量契约自检：未支持的变量运行时会被静默替换成空串，绝不能带病进库
    const tplProblems = validateTemplate(s.code, s.prompt)
    if (tplProblems.length) {
      problems.push(`${s.code} 模板校验不通过：${tplProblems.join('；')}`)
      continue
    }
    const r = await prisma.aiScene.updateMany({
      where: { code: s.code },
      data: { name: s.name, promptTemplate: s.prompt, fallbackTemplate: s.fallback, temperature: s.temperature },
    })
    if (r.count === 0) {
      problems.push(`${s.code} 场景不存在（先跑 npm run db:seed 建场景）`)
      continue
    }
    synced++
    console.log(`✓ ${s.code.padEnd(20)} ${s.prompt.length} 字`)
  }

  console.log(`\n已同步 ${synced}/${scenes.length} 个场景`)
  if (problems.length) {
    for (const p of problems) console.error(`✗ ${p}`)
    process.exitCode = 1
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => void prisma.$disconnect())
