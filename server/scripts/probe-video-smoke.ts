import { probeVideo } from '../src/render/ffmpeg.js'
import { writeFileSync, readdirSync, statSync } from 'node:fs'

// 伪视频：外部通道返回 HTTP 200 但内容不是视频的三种典型情况
writeFileSync('/tmp/fake-html.mp4', '<html><body>502 Bad Gateway</body></html>')
writeFileSync('/tmp/fake-empty.mp4', '')
writeFileSync('/tmp/fake-json.mp4', JSON.stringify({ error: 'quota exceeded' }))

console.log('=== 伪视频：必须被拒绝 ===')
for (const f of ['/tmp/fake-html.mp4', '/tmp/fake-empty.mp4', '/tmp/fake-json.mp4']) {
  const r = await probeVideo(f)
  const verdict = r.ok ? '✗ 误判为可用' : '✓ 正确拒绝'
  console.log(`${verdict}  ${f}\n    reason=${r.reason}`)
}

// 真实视频：必须被接受
function findMp4(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4 || out.length >= 3) return out
  let entries: string[] = []
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const e of entries) {
    const p = dir + '/' + e
    try {
      if (statSync(p).isDirectory()) findMp4(p, out, depth + 1)
      else if (e.endsWith('.mp4') && statSync(p).size > 10000) out.push(p)
    } catch {
      /* skip */
    }
    if (out.length >= 3) break
  }
  return out
}

const reals = findMp4('/Users/gaoyunhong/Documents/ChatGPT/Evvvv/server/storage')
console.log('\n=== 真实 mp4：必须被接受 ===')
console.log('找到 ' + reals.length + ' 个')
for (const f of reals) {
  const r = await probeVideo(f)
  const verdict = r.ok ? '✓ 正确接受' : '✗ 误判为坏片'
  console.log(verdict + '  ' + f + '\n    duration=' + r.durationMs + 'ms codec=' + r.videoCodec)
}
