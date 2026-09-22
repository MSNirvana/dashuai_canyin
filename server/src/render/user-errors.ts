/**
 * 合成失败文案的**用户可见出口**。
 *
 * ★ 为什么需要一个单独的映射层，而不是把异常原文改干净：
 *   `render_task.error_msg` 存的是**原始异常文本**。运维排查时必须看到原文 ——
 *   实测就是这么定位到「云端上传会话返回 HTTP 400：…requires complete metadata…」的。
 *   但同一列也被小程序 `pages/render/compose.tsx` **直接渲染给商户**，于是三类东西一起露到
 *   用户面前：① 第三方产品名（ChatCut / GPT / 内部网关代号）；② 服务端**本机绝对路径**
 *   （实测存量里躺着 5 条 `/Users/<开发者>/Documents/…/server/storage/uploads/1/xxx.mp4`）；
 *   ③ ffmpeg 命令行与 HTTP 报文。
 *
 *   一份数据、两个受众，只能在**出口分流**：
 *     · 库里 = 原文（运维看）→ `admin-extra.service.ts` 的裸查询，不受本模块影响；
 *     · 接口 `RenderTaskView.errorText` = 本模块映射后的文案（用户看）。
 *
 *   反过来「在写库时就洗掉」是错的：那等于拿可诊断性换体验 —— 下次线上故障时运维手里
 *   只剩一句「合成失败」，而真正的原因（HTTP 400 的响应体）已经被自己抹掉了。
 *
 * 出口唯一：`services/render.service.ts::toView()`。这也意味着**存量脏数据自动被覆盖**，
 * 不需要为历史行单独做一次数据订正（但历史行里不该留的东西仍应清掉，见 2026-09-18 的订正脚本）。
 */

/** 用户界面能安心承载的长度；再长会被截断成半句话，不如给通用话术 */
const MAX_USER_TEXT = 120

/**
 * 绝不允许出现在用户界面上的技术指纹。
 * 命中它又没被下面任何一条规则解释掉的原文，一律降级成通用话术 —— 宁可少说，不可乱说。
 */
const TECH_FINGERPRINT =
  /ChatCut|Chatcut|GPT|MCP|OpenAI|tokenbox|volcano|火山|ffmpeg|ffprobe|ENOENT|ETIMEDOUT|ECONNRESET|EAI_AGAIN|socket hang up|HTTP \d{3}|stack|at \w+ \(|Error:|before initialization|is not a function|is not defined|Cannot read propert|Cannot convert|Maximum call stack|[A-Za-z]:\\|\/(?:Users|home|var|tmp|opt)\//i

/**
 * 规则表：**顺序敏感，先匹配先返回**，所以「素材」类要排在通用「HTTP 403 / 未配置」之前 ——
 * 否则「取素材大小失败（HTTP 403）」那种素材侧的失败会被归因成通道故障，把用户引到错误的动作上。
 */
const RULES: [RegExp, string][] = [
  // ⓪ 退款/结算补偿没走通（failRender 的 catch 分支）。这条前缀后面跟的是**数据库层的原文**，
  //    对用户毫无意义；而任务状态此时是 SETTLEMENT_PENDING（界面上写「退款确认中」），
  //    所以这里只要把「钱的事我们记着」说清楚就够了。
  [
    /^积分释放失败|^预留积分释放失败/,
    '本次任务的积分结算正在处理中，稍后可在积分账户查看，如有异常请联系客服',
  ],
  // ① 素材文件本身读不到：对象已被 GC 回收、上传未完成、对象键打错
  [
    /源文件不存在|已被清理|ENOENT|no such file or directory/i,
    '分镜素材文件缺失（可能已被清理），请重新上传该分镜素材后重试',
  ],
  // ② 素材提交/探测环节：取大小、下载、导入注册、元数据不全
  [
    /取素材大小失败|下载素材失败|导入失败|元数据|大小非法|字节数非法|上传槽位|未返回上传槽位|import registration|complete metadata/i,
    '素材上传到云端合成失败，请重试；若反复失败请换一个素材',
  ],
  // ②½ 云端额度/计费类（2026-09-21 补）。
  //   背景：ChatCut 侧额度耗尽时不返回 401/403（那是鉴权），而是 402 或
  //   "insufficient credits" / "quota exceeded" 一类的文本 —— 它**不命中任何规则**，
  //   而 userFacingRenderError 末尾有一条「够短且不像技术噪音就原样保留」的分支，
  //   于是英文原文会被**直接展示给商户**。这里给它一个中文出口。
  //   ⚠ 对商户统一说「服务暂不可用」：额度是**平台成本**，不是商户能操作的东西，
  //     把「我们额度不够」告诉他既无用、又泄露了我们的供应商链路。
  //     真实原因照旧留在 render_task.error_msg 与日志里，运维看得到。
  //   ⚠ 必须排在 ④ 之前：ChatCut 的错误报文里常带 `MCP` 字样，先撞上 ④ 就没这条了。
  [
    /\b402\b|credit|quota|insufficient|billing|payment.?required|余额不足|额度/i,
    '云端合成服务暂不可用，请稍后重试，或改用「基础生成」',
  ],
  // ③ 任务提交/会话环节：上传会话、分片、ETag、项目与导出的 id
  [
    /分片上传|ETag|上传会话|签名地址|未返回 renderId|未返回 projectId|create_project|submit_export|upload.?session/i,
    '云端合成任务提交失败，请稍后重试，或改用「基础生成」',
  ],
  // ④ 授权/凭据/通道未配置
  [
    /授权|鉴权|unauthorized|invalid_grant|\b401\b|\b403\b|MCP|未配置|未返回成片地址|已完成但未返回/i,
    '云端合成服务暂不可用，请稍后重试，或改用「基础生成」',
  ],
  // ⑤ 网络与超时
  [
    /ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|timeout|超时/i,
    '云端合成响应超时，请稍后重试',
  ],
  // ⑥ 本地视频处理
  [
    /ffmpeg|ffprobe|Exit code|滤镜|转码|编码失败|no such filter/i,
    '视频处理失败，请确认素材能正常播放后重试',
  ],
  // ⑦ 配音
  [
    /配音|语音合成|TTS|voiceId|音色/i,
    '配音生成失败，请稍后重试，或换一个配音音色',
  ],
  // ⑧ 合成服务内部的 **JS 运行时错误**（2026-09-22 补，本轮线上故障暴露的第二处缺陷）。
  //   背景：那次故障的原文是 `Cannot access 'fps' before initialization` —— 它
  //     · 不命中上面任何一条规则，
  //     · 也不含产品名 / 路径 / 堆栈（没有 `Error:` 前缀），
  //     · 又短（46 字 ≤ MAX_USER_TEXT）
  //   ⇒ 落到末尾那条「够短且不像技术噪音就原样保留」的分支，**一句英文报错直接展示给了商户**
  //     （这就是用户截图里看到的东西）。
  //   TDZ / TypeError 这类文本对用户零信息量，且明显是**我们自己的**代码缺陷
  //   ⇒ 统一说「服务内部出错」，真实原文照旧留在 render_task.error_msg 与日志里给运维看。
  //   ⚠ 必须排在**最后**：前面的素材 / 额度 / 提交 / 授权 / 超时 / 配音规则都比它具体，
  //     先命中它们文案才准（例如带 `Cannot read properties of undefined` 的素材失败
  //     应该先说「素材」而不是「内部出错」）。
  [
    /before initialization|is not a function|is not defined|Cannot read propert|Cannot convert|Maximum call stack|ReferenceError|TypeError|SyntaxError|Unexpected token/i,
    '云端合成服务内部出错，请稍后重试；若反复失败请联系客服',
  ],
]

/**
 * 把服务端原始异常文本翻成**可以给用户看**的一句话。
 *
 * 命中规则表 → 用我们的说法；没命中但不是技术噪音且够短 → 原样保留（大多是业务提示，
 * 例如「请先为至少一个分镜上传素材」「素材缺少时长信息，无法计价」，这些本来就该直说）；
 * 其余（含路径、堆栈、报文、产品名的）→ 通用话术。
 */
export function userFacingRenderError(raw: string | null | undefined): string | null {
  const text = (raw ?? '').trim()
  if (!text) return null
  for (const [pattern, message] of RULES) {
    if (pattern.test(text)) return message
  }
  if (text.length <= MAX_USER_TEXT && !TECH_FINGERPRINT.test(text)) return text
  return '合成失败，本次预留的积分已自动退回，可稍后重试'
}
