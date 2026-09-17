/**
 * ChatCut 适配层端到端冒烟 —— **会真实产生副作用**：建项目、导素材、排时间线、导出成片。
 *
 * 它存在的理由：适配层写完之后，「能不能跑通」不能靠读代码判断，只能真跑一遍。
 * 本脚本用 ffmpeg 现场造两段 3 秒竖屏测试片 + 一段 6 秒配音，走完
 *   建项目 → 上传会话 → 4 步导入（含「预签名 PUT 原始字节」）→ 排轨 → 设角色 → 导出 → 轮询
 * 最后打印真实 downloadUrl。跑通即说明：
 *   ★ 服务端（无头、没有本地素材文件）可以从**字节流**把素材推进 ChatCut —— 这是整条路的命门。
 *
 * 用法：
 *   npx tsx scripts/chatcut-smoke.ts                # 跑完自动软删测试项目
 *   npx tsx scripts/chatcut-smoke.ts --keep         # 保留项目，便于在浏览器里看
 *   npx tsx scripts/chatcut-smoke.ts --captions     # 额外开字幕（依赖转录，慢）
 *   npx tsx scripts/chatcut-smoke.ts --no-export    # 只验到排轨为止，不消耗渲染
 */
import 'dotenv/config'
import { createReadStream, statSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  addChatCutItems,
  createChatCutProject,
  createImportSession,
  deleteChatCutProject,
  enableChatCutCaptions,
  importAsset,
  listChatCutTracks,
  setChatCutTrackRole,
  submitChatCutExport,
  trackChatCutExport,
  type ChatCutUploadSource,
} from '../src/render/chatcut-driver.js'

const run = promisify(execFile)
const FFMPEG = process.env.FFMPEG_PATH?.trim() || 'ffmpeg'
const KEEP = process.argv.includes('--keep')
const WITH_CAPTIONS = process.argv.includes('--captions')
const DO_EXPORT = !process.argv.includes('--no-export')

function step(message: string): void {
  console.log(`\n── ${message} ${'─'.repeat(Math.max(0, 60 - message.length))}`)
}

/**
 * ★ 必须显式收尾。
 * `src/render/chatcut.ts` 会连 Redis 做 access-token 缓存，ioredis 的连接会把事件循环
 * 一直挂住 —— 冒烟其实已经跑完，但进程不退出，表现为「脚本卡死」，
 * 再叠加 `| tail` 的整段缓冲，就变成「跑了 7 分钟一个字的输出都看不到」。
 * 第一次跑就是这么被误判成失败的。
 */
async function shutdown(): Promise<void> {
  try {
    const { redis, prisma } = await import('../src/db.js')
    redis.disconnect()
    await prisma.$disconnect()
  } catch {
    // 收尾失败不该影响退出码
  }
}

/** 造一段竖屏测试片：带音轨，正好覆盖「视频素材 + 内嵌音频」这个真实形状 */
async function makeClip(path: string, color: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', `color=c=${color}:size=1080x1920:rate=30`,
    '-f', 'lavfi', '-i', `sine=frequency=440`,
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-b:a', '64k',
    '-shortest',
    path,
  ])
}

async function makeVoice(path: string, seconds: number): Promise<void> {
  await run(FFMPEG, [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220',
    '-t', String(seconds),
    '-c:a', 'libmp3lame', '-b:a', '64k',
    path,
  ])
}

function fileSource(
  path: string,
  assetType: 'video' | 'audio',
  filename: string,
  contentType: string,
  meta: ChatCutUploadSource['meta'],
  startTranscription = false,
): ChatCutUploadSource {
  const size = statSync(path).size
  return {
    filename,
    contentType,
    assetType,
    size,
    open: (range) => createReadStream(path, range ? { start: range.start, end: range.endInclusive } : undefined),
    meta,
    startTranscription,
  }
}

async function main(): Promise<void> {
  if (!process.env.CHATCUT_OAUTH_REFRESH_TOKEN?.trim() && !process.env.CHATCUT_MCP_ACCESS_TOKEN?.trim()) {
    throw new Error('缺少 ChatCut 凭证：先跑 npm run chatcut:authorize -- --write')
  }
  const dir = await mkdtemp(join(tmpdir(), 'chatcut-smoke-'))
  let projectId = ''
  try {
    step('① 造测试素材（ffmpeg）')
    const clipA = join(dir, 'shot-a.mp4')
    const clipB = join(dir, 'shot-b.mp4')
    const voice = join(dir, 'voice.mp3')
    await makeClip(clipA, 'navy', 3)
    await makeClip(clipB, 'darkgreen', 3)
    await makeVoice(voice, 6)
    console.log(`  clipA=${(statSync(clipA).size / 1024).toFixed(0)}KB clipB=${(statSync(clipB).size / 1024).toFixed(0)}KB voice=${(statSync(voice).size / 1024).toFixed(0)}KB`)

    step('② create_project（显式 1080×1920）')
    const project = await createChatCutProject({
      name: `dashuai-smoke-${Date.now()}`,
      width: 1080,
      height: 1920,
      fps: 30,
      description: '大帅餐饮 ChatCut 适配层冒烟测试',
    })
    projectId = project.projectId
    console.log(`  projectId=${projectId}`)
    console.log(`  timelineId=${project.timelineId ?? '(未返回)'}`)
    console.log(`  editorUrl=${project.editorUrl ?? '(未返回)'}`)

    step('③ import_media create_session（一次最多 4 个素材）')
    const session = await createImportSession(projectId)
    console.log(`  endpoint=${session.endpoint}`)
    console.log(`  过期于=${new Date(session.expiresAtMs).toISOString()}`)
    console.log('  ★ 接下来全部由本进程完成，不需要官方 upload-media.mjs 助手')

    step('④ 4 步导入：占位登记 → 申请槽位 → PUT 字节 → finalize')
    const assetA = await importAsset(session, fileSource(clipA, 'video', 'shot-a.mp4', 'video/mp4', {
      durationInSeconds: 3,
      width: 1080,
      height: 1920,
      hasAudioTrack: true,
    }))
    console.log(`  ✓ shot-a assetId=${assetA}`)
    const assetB = await importAsset(session, fileSource(clipB, 'video', 'shot-b.mp4', 'video/mp4', {
      durationInSeconds: 3,
      width: 1080,
      height: 1920,
      hasAudioTrack: true,
    }))
    console.log(`  ✓ shot-b assetId=${assetB}`)
    const assetVoice = await importAsset(session, fileSource(voice, 'audio', 'voice.mp3', 'audio/mpeg', {
      durationInSeconds: 6,
    }, true))
    console.log(`  ✓ voice  assetId=${assetVoice}（已请求 ASR 转录）`)

    step('⑤ 读轨道别名')
    const tracks = await listChatCutTracks(projectId)
    const trackDump = JSON.stringify(tracks)
    console.log(`  ${trackDump.slice(0, 700)}`)
    const aliases = [...trackDump.matchAll(/"([VA]\d+)"/g)].map((match) => match[1]!)
    const videoTrack = aliases.find((alias) => alias.startsWith('V')) ?? 'V1'
    const audioTrack = aliases.find((alias) => alias.startsWith('A')) ?? 'A1'
    console.log(`  采用 videoTrack=${videoTrack} audioTrack=${audioTrack}`)

    step('⑥ 排轨（帧原生；视频链式 alignTo:track-end）')
    const added = await addChatCutItems(projectId, [
      { type: 'video', assetId: assetA, fromFrame: 0, trackId: videoTrack },
      { type: 'video', assetId: assetB, alignTo: 'track-end', trackId: videoTrack },
      { type: 'audio', assetId: assetVoice, fromFrame: 0, trackId: audioTrack, audioFadeOut: 0.5 },
    ])
    console.log(`  ${JSON.stringify(added).slice(0, 900)}`)

    step('⑦ 设轨道角色（anchor=人声 ⇒ 其它 follower 轨自动闪避）')
    const role = await setChatCutTrackRole(projectId, audioTrack, 'anchor')
    console.log(`  ${JSON.stringify(role).slice(0, 500)}`)

    if (WITH_CAPTIONS) {
      step('⑧ 开字幕（从转录派生）')
      try {
        const captions = await enableChatCutCaptions(projectId)
        console.log(`  ${JSON.stringify(captions).slice(0, 600)}`)
      } catch (error) {
        console.log(`  ⚠ 开字幕失败（通常是转录还没就绪，不是适配层问题）：${(error as Error).message}`)
      }
    }

    if (DO_EXPORT) {
      step('⑨ 导出')
      const renderIds = await submitChatCutExport(projectId, {
        format: 'video',
        codec: 'h264',
        resolution: '1080p',
        fps: 30,
        name: 'dashuai-smoke',
      })
      console.log(`  renderIds=${renderIds.join(',')}`)

      const deadline = Date.now() + Number(process.env.CHATCUT_SMOKE_WAIT_MS ?? 600_000)
      let last = ''
      let downloadUrl: string | undefined
      while (Date.now() < deadline) {
        const status = await trackChatCutExport(projectId, renderIds[0]!)
        if (status.status !== last) {
          console.log(`  [${new Date().toISOString()}] ${status.status}`)
          last = status.status
        }
        if (status.status === 'SUCCESS') {
          downloadUrl = status.downloadUrl
          break
        }
        if (status.status === 'FAILED') throw new Error(`导出失败：${status.errorMessage ?? '未给原因'}`)
        // track_export 的 wait 只是一次即时读取，非终态必须自己隔开重查
        await new Promise((resolve) => setTimeout(resolve, 10_000))
      }
      if (!downloadUrl) throw new Error('导出超时未拿到 downloadUrl')
      step('✓ 成片地址')
      console.log(`  ${downloadUrl}`)
      console.log('  ★ 这一行就是「路径可行」的硬证据：整个流程在无头进程里跑完了。')
    } else {
      console.log('\n（--no-export：跳过导出）')
    }

    if (project.editorUrl) console.log(`\n项目地址：${project.editorUrl}`)
  } finally {
    if (projectId && !KEEP) {
      try {
        await deleteChatCutProject(projectId)
        console.log(`\n已软删测试项目 ${projectId}（可用 restore_project 还原）`)
      } catch (error) {
        console.warn(`\n⚠ 测试项目 ${projectId} 删除失败，请手动清理：${(error as Error).message}`)
      }
    }
    await rm(dir, { recursive: true, force: true })
  }
}

void main().then(
  async () => {
    await shutdown()
    process.exit(0)
  },
  async (error) => {
    console.error(`\n✗ 冒烟失败：${(error as Error).message}`)
    await shutdown()
    process.exit(1)
  },
)
