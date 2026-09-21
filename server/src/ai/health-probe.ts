// 通道探活用的**合法**请求体。
//
// ★ 为什么不能再用 `user: 'ping'`（这是本轮实测出来的，不是推测）：
//   上游对「短输入 + 极小 max_tokens」这类请求的处理**不稳定** —— 同一个请求体在不同
//   时刻会给出完全不同、且都无法解释的结果。直连 tokenbox-gpt / gpt-5.5 实测：
//     2026-09-16   user='ping', maxOut=16 → HTTP 200，4.9s（正常）
//     2026-09-21a  user='ping', maxOut=16 → HTTP 400 ×3（0.7s / 12s / 88s）
//       {"error":{"message":"Upstream rejected illegal short-input
//         distillation or heartbeat probing.","type":"invalid_request_error"}}
//     2026-09-21b  user='ping', maxOut=16 → HTTP 200，**90.0s**，out=5，text="pong"
//       （同一天、同通道、同请求体 —— 这次没有被拒）
//   不管它返回哪种结果，拿它当判据的后果都是静默的：
//     ① 后台「测试」按钮对 tokenbox-gpt **常常显示失败**（现网 last_test_status=FAILED
//        / latency=10002ms 就是这么来的），运营会误以为通道坏了；
//     ② 用它做 30 分钟健康体检的判据 ⇒ **会把完全可用的主力通道自动停用**，
//        流量全落到更贵的备用通道。这不是理论风险：这条通道是 9 个文案场景的默认模型。
//
// ★ 所以「换掉 ping」的理由**不是**「ping 会被拒」（那个策略会变，今天就没复现），而是：
//   **ping 的读数与业务可用性无关，且读数本身不稳定。** 一个 90 秒的 ping、或一个
//   `finish_reason=length` 的空正文 ping，无论成败都回答不了「这个模型能否按时干完我们
//   场景的活」。把自动停用建在它上面 ⇒ 随机误停主力通道（它是 9 个文案场景的默认模型），
//   流量全落到更贵的备用通道。
//
// 所以探活必须发一个**看起来像真实业务请求**的内容型提示词。实测同一个合法请求体：
//   tokenbox-gpt   35.7s（in=88 / out=20）
//   tokenbox-claude 2.5s（in=170 / out=16）
//   tokenbox-deepseek 2.4s（in=165 / out=124）
//   —— 三条都接受，且输出金额可忽略（≤ 几分）。
//
// ★ maxOutputTokens 取 64 而不是 16：推理模型会把 max_tokens 当「思考 + 正文」的总预算，
//   16 会整段被思考吃掉，得到 HTTP 200 + 空正文（适配层判为失败）—— 那又是一次假失败。
//   实测：claude 在 16 下报 `empty content (finish_reason=length)`（2.7s，HTTP 200，
//   报文 JSON 语法完全合法 ⇒ 只看状态码看不出问题）；`user='ping'` 在 gpt 上同样如此；
//   在 64 下三条通道都正常。
//
// ★ 换成内容型探活**也还是不能单独判活/判死**（护栏见 ai-health.service.ts）：
//   它自己同样会超时 —— 同一条 gpt 通道、108 字真业务提示词（maxOut=64）实测一次
//   超过 90s 无返回。慢与死之间没有固定边界，所以必须叠「窗口内有真实成功 ⇒ 免探测」。
export const HEALTH_PROBE_PROMPT =
  '请用一句话（不超过 30 字）概括下面这段门店介绍的主要卖点。\n' +
  '介绍：本店主营川味小炒，招牌是藤椒牛蛙和干锅千页豆腐，人均消费五十元左右，' +
  '中午十一点营业到晚上九点，节假日不休息，门店在市中心步行街二楼，提供免费停车。'

export const HEALTH_PROBE_MAX_OUTPUT_TOKENS = 64

/**
 * 图像通道（capability='IMAGE'）探活用的**合法出图提示词**。
 *
 * ★ 图像通道不能用上面那段文本提示词去探：出图接口把 `user` 当成**画面描述**，
 *   塞一段「请用一句话概括下面这段门店介绍」进去，得到的结果与「通道能否出图」无关
 *   （照样可能 200，也可能因为内容审核差异而 400 —— 两种读数都不可解释）。
 *
 * ★ 更关键的是：图像通道的探活**不是免费的**。实测（2026-09-21，tokenbox / gpt-image-2，
 *   size=1024x1365）单张 $0.10、耗时 35.7s、返回 `data[0].url`、`usage=null`。
 *   所以它绝不能按文本通道的 30 分钟节奏探 —— 见 ai-health.service.ts 的
 *   `AI_HEALTH_IMAGE_PROBE_MS` 节流与「图像通道只探 1 轮」。
 *
 * 提示词本身选一个「一定不含文字/水印、不涉敏感内容」的简单静物：
 * 内容越简单，被上游内容审核拒掉（从而造成假失败）的概率越低。
 */
export const HEALTH_PROBE_IMAGE_PROMPT =
  'a red apple on a plain white table, soft daylight, simple product photo, no text'
