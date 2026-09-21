// ⚠ 已废弃（2026-09-21）。本脚本**不要运行**，只保留作历史记录。
//
// 废弃原因：
//   1) 它把 `mock-chat` / `mock-reasoner` 写进 `copy_generate` / `storyboard_generate` 的
//      `fallbackModelIds`（兜底位）。而 MOCK 适配器**不发网络请求、直接返回样例文案** ——
//      真实通道全挂时，商户收到的会是一段看起来正常、其实是占位样例的「文案」且照常扣费。
//   2) 它只覆盖 2 个场景，后来又新增了 3 款文案场景（见 docs/09-AI-Skill清单.md），
//      绑定本身也已经不完整。
//   3) 它接入的 `gpt-5.6-sol` 通道已停用（实测 1/3 概率 36s > 场景 30s 超时线）。
//
// 正解：`cd server && npx tsx scripts/setup-ai-channels.ts`
//   —— 幂等重建 11 个场景的真实候选链（默认 tokenbox-gpt/gpt-5.5 → claude-sonnet-5 → deepseek-v4-flash，
//   `storyboard_generate` 有单独的备用顺序与 90s 超时覆盖），并停用历史供应商。
//   Key 一律走环境变量（`TB_GPT_KEY` / `TB_CLAUDE_KEY` / `TB_DEEPSEEK_KEY`），
//   配置细则见 `deploy/AI通道配置-2026-09-15.md`。
//
// ⚠ 不要把 key 硬编码在这个文件里。
//   本仓库是 **public** 的 —— 密钥一旦提交即等于向全网公开（会被爬虫秒抓走）。
//   历史上这里曾硬编码过一个 `sk-...`，已移除；那把 key 必须视为已泄露并作废重签
//   （处置记录见 `deploy/密钥泄露处置-2026-09-15.md`）。

throw new Error(
  [
    'setup-gpt5sol.ts 已废弃（2026-09-21）：它会把 MOCK 模型写回场景的兜底位，且通道已停用。',
    '  请改用：cd server && npx tsx scripts/setup-ai-channels.ts',
    '  （需要 TB_GPT_KEY / TB_CLAUDE_KEY / TB_DEEPSEEK_KEY，幂等可重复跑）',
  ].join('\n'),
)
