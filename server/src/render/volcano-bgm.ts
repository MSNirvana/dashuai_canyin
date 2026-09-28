/**
 * 火山引擎「AI 音乐生成大模型」纯音乐（GenBGM）适配层 —— 配乐的**第二个生成源**。
 *
 * ★ 为什么加它：原先生成源只有 ChatCut 的 `submit_music`（模型是 mureka-9）。
 *   本模块提供一条**可替换的**生成源，两者由 `BGM_SOURCE` 环境变量切换，
 *   这样「换供应商」不需要动渲染链路一行代码。
 *
 * ★★ 鉴权与火山 TTS **不是同一套**（这是最容易踩的坑）：
 *   - TTS 走 `openspeech.bytedance.com` + `X-Api-Key`（API Key 鉴权）；
 *   - 本接口走 `open.volcengineapi.com` + **AK/SK 的 v4 签名**（AWS SigV4 风格）。
 *   所以「已经在用火山 TTS」**不等于**凭证可复用，必须另建 AccessKey。
 *   密钥获取：控制台右上角账号 → 密钥管理 → 新建密钥。建议用**子账户**的 AK/SK。
 *
 * ★ 接口（文档 Version=2024-08-12，模型版本 v5.0）：
 *   - 提交：`POST /?Action=GenBGMForTime&Version=2024-08-12`（后付费，按秒计费）
 *           预付费则用 `Action=GenBGM`（套餐包按「首」扣）
 *   - 查询：`POST /?Action=QuerySong&Version=2024-08-12`，Body `{ TaskID }`
 *   - 结果：`Result.SongDetail.AudioUrl`
 *
 * ★ 签名固定值（写死在文档里，不要猜）：`Service=imagination`、`Region=cn-beijing`、
 *   `Host=open.volcengineapi.com`。Authorization 形态：
 *   `HMAC-SHA256 Credential={AK}/{ShortDate}/{Region}/{Service}/request,
 *    SignedHeaders={...}, Signature={...}`
 *
 * ★★ 时长：`Duration` 在 **v5.0 的下限是 30s**（v4.0 是 [1,60]），上限 120s。
 *   本项目**必须 ≥65s**（`synthesis.ts::mixAudioTracks()` 用 `amix=duration=longest`
 *   且不做循环，曲子比成片短会中途静音且不报错），所以默认取满 **120s**。
 *
 * ⚠ 文档明确提示：**「入参简单的 30s 短音乐容易触发版权校验（code 50000001）」**，
 *   建议「丰富 text、增加参数数量、延长生成音乐时长」来规避。
 *   这就是本模块默认 120s、并给每个风格准备多条中文描述的原因。
 *
 * ⚠ 生成是**异步**的，实测同类接口耗时 **1~5 分钟**，且公共资源池 QPS ≤ 2、峰值排队。
 *   ⇒ **只能在运维/补货动作里调用，绝不能放进渲染链路。**
 *
 * ★ 已验证可用（2026-09-28）：本仓线上曲库已用这条源真生成过曲子（AK/SK 齐全、
 *   `GenBGMForTime` + `QuerySong` + 下载一条龙跑通，落盘为 `assets/bgm/<风格>/<风格>-<ts>.wav`）。
 *   但这不等于「参数怎么填都行」—— 改动 `Text`/`Duration`/`Version` 前仍请先 `--dry-run` 核对请求体。
 */
import { createHash, createHmac, randomInt } from 'node:crypto'
import { safeFetch } from '../lib/outbound-url.js'
import type { BgmStyle } from './bgm-library.js'

const API_HOST = 'open.volcengineapi.com'
const API_VERSION = '2024-08-12'
const DEFAULT_REGION = 'cn-beijing'
/** 文档固定值，不要改成 `music` 之类想当然的名字 */
const DEFAULT_SERVICE = 'imagination'
const REQUEST_TERMINATOR = 'request'

/** 本项目的硬下限是 65s；取满 120s，同时也降低触发版权校验的概率 */
export const VOLCANO_BGM_MIN_SEC = 30
export const VOLCANO_BGM_MAX_SEC = 120
export const VOLCANO_BGM_DEFAULT_SEC = 120

/**
 * 每个风格的**多条中文描述**。
 *
 * ★ 为什么是数组：池子要「同风格多条曲子」，补货时优先取池里没用过的（只有手工单发才随机取） ⇒ 池子里的曲子才有差异。
 * ★ 为什么是中文：该接口 `Text` **仅支持中文**（英文会被拒或退化），
 *   所以不能直接复用 `chatcut.ts::BGM_PROMPTS` 那三段英文。
 * ★ 每条都写足「曲风 + 乐器 + 情绪 + 场景 + 无人声」，既提升听感也规避版权校验。
 */
/**
 * 容量上限：**表里有几条，池子就别超过几首**。
 *
 * 补货脚本按「池内已有数量 + 序号」顺次取词，一旦目标数超过本表条数，就必然回到
 * 起点取到同一批描述 ⇒ 池子里长出近乎重复的曲子，而且**全程不报任何错**。
 * `bgm-replenish.ts` 在预检阶段会显性告警；要更大的池子，先往这张表里加词。
 */
export const VOLCANO_BGM_PROMPTS: Record<BgmStyle, string[]> = {
  LIGHT: [
    '轻柔温暖的背景纯音乐，钢琴与木吉他为主，节奏舒缓，音量克制不抢人声，情绪放松治愈，适合餐饮门店短视频的口播旁白垫底，全程没有人声',
    '安静治愈的背景音乐，钢琴铺底加少量弦乐，速度中慢，明亮而不吵闹，适合美食探店日常片段，全程没有人声',
    '轻快的原声吉他小品，配轻盈的打击乐点缀，温暖有生活气息，适合小店日常记录类短视频，全程没有人声',
    '清新明快的小清新纯音乐，尤克里里与钢片琴为主，节奏轻巧跳跃，甜而不腻，适合甜品与饮品门店的日常片段，全程没有人声',
    '温暖朴实的民谣风纯音乐，口琴与木吉他互相应和，速度从容，带一点市井烟火气，适合街边小店与手作过程镜头，全程没有人声',
    '慵懒惬意的午后氛围纯音乐，电钢琴配轻沙锤，速度偏慢，松弛不催人，适合咖啡馆与下午茶场景，全程没有人声',
    '干净通透的钢琴小品，音色清亮如八音盒，速度中慢，情绪温柔安心，适合甜品成品与摆盘特写，全程没有人声',
    '轻柔的轻爵士纯音乐，钢琴与低音贝斯轻轻走动，鼓刷轻点，从容有格调又不抢戏，适合门店日常与人情味镜头，全程没有人声',
    '温暖的手风琴小品，配木吉他与轻拨弦，速度中慢，旧时光的亲切感，适合老字号门店与家常菜镜头，全程没有人声',
    '明亮的口哨主题纯音乐，配木吉他扫弦与轻拍手，轻松随意，适合门店开门准备与摆台镜头，全程没有人声',
    '舒缓的凯尔特风格纯音乐，竖琴与长笛相互呼应，空灵通透，适合茶饮与花艺门店，全程没有人声',
    '温柔的拇指琴纯音乐，配少量电钢琴铺底，音色晶莹，速度缓慢，适合甜品与烘焙过程特写，全程没有人声',
    '闲适的木吉他指弹小品，加入轻巧的沙锤与三角铁，节奏从容，适合午后门店与顾客闲聊镜头，全程没有人声',
    '清新的巴沙诺瓦风纯音乐，尼龙弦吉他与轻爵士鼓刷，慵懒摇摆，适合咖啡馆与轻食门店，全程没有人声',
    '治愈系的风铃与钢琴纯音乐，加入极轻的氛围铺底，安静悠长，适合夜晚门店与收档镜头，全程没有人声',
    '朴素的八音盒旋律纯音乐，配轻柔弦乐衬底，童趣温暖，适合亲子餐厅与手作体验，全程没有人声',
    '轻巧的口琴民谣纯音乐，配曼陀铃与轻打点，市井又干净，适合早餐店与街头小吃摊，全程没有人声',
    '舒缓的竖琴独奏纯音乐，偶有长笛点缀，空灵柔和，适合素食与轻食门店的成品特写，全程没有人声',
    '明快的手碟与钢琴纯音乐，节奏轻盈有律动，情绪舒展，适合新店开业与试营业记录，全程没有人声',
    '温暖的萨克斯轻爵士纯音乐，配钢琴与低音贝斯，松弛有质感，适合烤肉与火锅门店的用餐氛围镜头，全程没有人声',
    '简约的吉他泛音纯音乐，留白充足、速度缓慢，安静克制，适合门店招牌与门头展示，全程没有人声',
    '清爽的马林巴纯音乐，配轻快木琴与沙锤，颗粒感明亮，适合水果与果切类镜头，全程没有人声',
    '柔和的风琴与吉他重奏纯音乐，带一点乡土气息，温暖踏实，适合农家菜与土特产展示，全程没有人声',
    '轻快的口哨加尤克里里纯音乐，节奏弹跳，阳光随性，适合饮品制作与出杯镜头，全程没有人声',
    '安静的钢琴叙事纯音乐，副歌处加薄弦乐，情绪内敛，适合老板出镜讲述类镜头垫底，全程没有人声',
    '慵懒的电钢琴与爵士吉他纯音乐，速度慢而不拖，适合小酒馆与夜宵场景，全程没有人声',
    '温暖的口琴蓝调纯音乐，配轻吉他扫弦，情绪低回但有温度，适合老店故事与传承类镜头，全程没有人声',
    '清新的钢片琴与木吉他纯音乐，音色通透清冽，适合凉菜与冷饮类镜头，全程没有人声',
    '从容的民谣吉他纯音乐，配轻手鼓与口琴，叙事感强，适合门店一天流水式记录，全程没有人声',
    '柔美的二重奏纯音乐，钢琴与小提琴轮流主奏，情绪温柔有层次，适合家庭聚餐与团圆场景，全程没有人声',
  ],
  UPBEAT: [
    '明快活泼的背景纯音乐，轻电子流行风格，鼓点鲜明节奏感强，情绪积极有活力，适合美食制作过程类短视频，全程没有人声',
    '向上的轻快电子音乐，合成器与打击乐，节拍清晰不杂乱，适合菜品出锅与出餐镜头，全程没有人声',
    '欢快跳跃的纯音乐，轻快鼓组加明亮合成器音色，能量充沛有推进感，适合餐饮促销类短视频，全程没有人声',
    '律动感强的放克风纯音乐，切分吉他配明亮铜管点缀，节奏有弹性，适合翻炒与出餐等动作感强的镜头，全程没有人声',
    '弹跳感十足的电子纯音乐，厚实底鼓配清脆拍手，速度明快，适合菜品制作快剪与踩点剪辑，全程没有人声',
    '阳光明快的乡村风纯音乐，班卓琴与木吉他，节奏轻快，朴实热闹有烟火气，适合集市采购与食材展示，全程没有人声',
    '律动劲爽的流行电子纯音乐，合成器音色明亮，鼓组干脆利落，适合限时优惠与活动促销类短视频，全程没有人声',
    '轻快的嘻哈风纯音乐，松弛鼓点配温暖键盘，节奏舒服有推进力，适合门店日常流水式记录，全程没有人声',
    '活力四射的迪斯科风纯音乐，弦乐断奏配四踩底鼓，复古热闹，适合夜宵排档与聚餐场景，全程没有人声',
    '带感的电子摇滚纯音乐，失真吉他配密集鼓组，能量充沛，适合爆炒与火焰镜头，全程没有人声',
    '轻快的雷鬼风纯音乐，切分吉他配松弛鼓点，热带阳光感，适合夏日饮品与冰品促销，全程没有人声',
    '明快的桑巴风纯音乐，打击乐密集节奏热烈，适合人多热闹的堂食场景，全程没有人声',
    '干脆的鼓打贝斯纯音乐，低频厚重节奏跳跃，速度明快，适合出餐快剪与踩点剪辑，全程没有人声',
    '欢乐的摇摆爵士纯音乐，铜管齐奏配钢琴切分，喜庆上扬，适合节庆与周年庆活动，全程没有人声',
    '弹跳的电子放克纯音乐，合成器贝斯配拍手，节奏律动强，适合新品上架与主推菜品，全程没有人声',
    '明快的口琴与鼓组纯音乐，速度偏快有推进感，适合外卖打包与出单流水镜头，全程没有人声',
    '活泼的木管与打击纯音乐，长笛与短笛穿插，色彩明亮，适合小朋友与亲子餐厅，全程没有人声',
    '劲道的摇滚纯音乐，鼓组干净有力配贝斯走句，适合烧烤与铁板类动感镜头，全程没有人声',
    '轻快的电子舞曲纯音乐，明亮主旋律配厚实底鼓，情绪高涨，适合限时折扣与秒杀活动，全程没有人声',
    '跳跃的爵士放克纯音乐，电钢琴切分配铜管点缀，都市感强，适合商场内餐饮门店，全程没有人声',
    '活力的乡村摇滚纯音乐，班卓与电吉他互答，热闹不拘，适合集市与摆摊记录，全程没有人声',
    '急促的拉丁打击纯音乐，康加鼓与沙锤层层推进，适合快节奏菜品制作，全程没有人声',
    '喜庆的中式打击纯音乐，锣鼓与唢呐点缀，热烈欢腾，适合开业庆典与年节促销，全程没有人声',
    '明快的合成器流行纯音乐，副歌处旋律上扬，情绪昂扬，适合品牌活动与门店宣传，全程没有人声',
    '轻快的放克铜管纯音乐，小号与萨克斯相互挑逗，热闹有趣，适合互动类与探店镜头，全程没有人声',
    '弹跳的电子游戏风纯音乐，芯片音色配轻快鼓组，俏皮活泼，适合趣味剪辑与转场段，全程没有人声',
    '强节奏的电子浩室纯音乐，四踩底鼓配明亮合成器，适合运动感与快切镜头，全程没有人声',
    '欢快的手鼓与吉他纯音乐，节奏轻捷有呼吸感，适合户外与露营风门店记录，全程没有人声',
    '劲爽的管乐进行曲纯音乐，小号与长号齐奏，气势上扬，适合大促开场与排队场景，全程没有人声',
    '明快的朋克风纯音乐，吉他扫弦干脆配疾速鼓点，冲劲十足，适合夜宵与酒水主推，全程没有人声',
  ],
  PREMIUM: [
    '高级质感的背景纯音乐，温暖弦乐铺底加钢琴点缀，电影配乐质感，大气舒缓，适合餐饮品牌形象片，全程没有人声',
    '优雅沉稳的氛围纯音乐，弦乐与氛围合成器，画面感强不张扬，适合门店环境与装修展示，全程没有人声',
    '舒缓大气的品牌配乐，弦乐渐进发展，情绪层层推进有仪式感，适合品牌宣传与菜品主推，全程没有人声',
    '沉稳高级的品牌纯音乐，大提琴主奏配钢琴点缀，气度从容，适合品牌创始人与门店故事讲述，全程没有人声',
    '极简主义的钢琴纯音乐，单音线条干净留白充足，克制而高级，适合菜品特写与大段留白画面，全程没有人声',
    '影视感的弦乐纯音乐，由弱到强层层推进，画面张力强，适合品牌形象片的高潮段落，全程没有人声',
    '开阔大气的氛围电子纯音乐，低频垫底配空灵合成器音色，空间感强，适合门店空间与环境展示，全程没有人声',
    '雅致的中式纯音乐，竹笛与古筝点缀，配少量弦乐，东方韵味悠长，适合中式餐饮与茶饮品牌宣传，全程没有人声',
    '庄重的弦乐与管风琴纯音乐，缓慢铺陈，仪式感强，适合老字号与品牌里程碑短片，全程没有人声',
    '通透的钢琴与长笛二重奏纯音乐，线条清雅，情绪含蓄，适合茶室与高端中式餐饮，全程没有人声',
    '沉静的氛围电子纯音乐，低频缓动配空灵音色，空间开阔，适合门店空间与灯光展示，全程没有人声',
    '大气的交响纯音乐，铜管与弦乐呼应推进，气势恢宏，适合品牌宣传片开场，全程没有人声',
    '内敛的大提琴独奏纯音乐，偶有钢琴低音衬托，情绪深沉，适合创始人心路讲述，全程没有人声',
    '优雅的竖琴与弦乐纯音乐，音色华美流畅，适合高端甜品与下午茶场景，全程没有人声',
    '舒缓的氛围吉他纯音乐，加入细微的弦乐铺底，安静而高级，适合菜品摆盘与特写，全程没有人声',
    '现代的极简电子纯音乐，脉冲式音色配干净留白，克制有力，适合科技感门店形象片，全程没有人声',
    '悠远的中式管弦纯音乐，洞箫与琵琶交替，配弦乐衬底，东方意境，适合中式正餐与宴请场景，全程没有人声',
    '肃穆的弦乐慢板纯音乐，力度层层叠加，情绪饱满，适合品质承诺与匠人镜头，全程没有人声',
    '精致的室内乐纯音乐，钢琴三重奏质感，细腻考究，适合私房菜与精品门店，全程没有人声',
    '辽阔的弦乐与电子混合纯音乐，低频空间感强配空灵高音，适合航拍与门头远景，全程没有人声',
    '温厚的大提琴与弦乐群纯音乐，旋律平稳上行，安定可靠，适合连锁品牌与标准流程展示，全程没有人声',
    '淡雅的钢琴与古琴纯音乐，音符疏落留白多，气韵悠长，适合茶饮与素食品牌，全程没有人声',
    '高级的爵士钢琴纯音乐，和声丰富配低音贝斯轻走，格调从容，适合酒类与高端酒水主推，全程没有人声',
    '明朗的弦乐小快板纯音乐，节奏轻捷不失稳重，适合品牌新品发布，全程没有人声',
    '沉静的颂歌风纯音乐，弦乐与铜管层层铺开，庄严温暖，适合周年与感恩主题，全程没有人声',
    '电影感的钢琴与弦乐纯音乐，由缓入强再收，情绪完整，适合门店故事短片高潮，全程没有人声',
    '清冷的氛围钢琴纯音乐，音色通透带颗粒感，克制疏离，适合极简风格门店，全程没有人声',
    '悠长的箫与弦乐纯音乐，气声细腻，意境深远，适合高端茶饮与中式点心，全程没有人声',
    '厚重的管弦纯音乐，低音弦乐垫底配定音鼓点缀，沉稳有力，适合品牌实力与规模展示，全程没有人声',
    '雅致的弦乐与长笛纯音乐，旋律婉转向上，气质端方，适合宴席与商务宴请场景，全程没有人声',
  ],
}

export interface VolcanoBgmCredentials {
  accessKey: string
  secretKey: string
  region: string
  service: string
}

/** 读取 AK/SK。缺任一即视为未配置（返回 null，而不是抛错）。 */
export function volcanoBgmCredentials(): VolcanoBgmCredentials | null {
  const accessKey = process.env.VOLCENGINE_ACCESS_KEY?.trim()
  const secretKey = process.env.VOLCENGINE_SECRET_KEY?.trim()
  if (!accessKey || !secretKey) return null
  return {
    accessKey,
    secretKey,
    region: process.env.VOLCENGINE_BGM_REGION?.trim() || DEFAULT_REGION,
    service: process.env.VOLCENGINE_BGM_SERVICE?.trim() || DEFAULT_SERVICE,
  }
}

export function volcanoBgmConfigured(): boolean {
  return volcanoBgmCredentials() !== null
}

/** 启动/脚本自检用：把缺哪个变量说清楚，而不是让人对着「签名失败」猜 */
export function describeVolcanoBgmConfig(): { configured: boolean; missing: string[]; region: string; service: string } {
  const missing: string[] = []
  if (!process.env.VOLCENGINE_ACCESS_KEY?.trim()) missing.push('VOLCENGINE_ACCESS_KEY')
  if (!process.env.VOLCENGINE_SECRET_KEY?.trim()) missing.push('VOLCENGINE_SECRET_KEY')
  return {
    configured: missing.length === 0,
    missing,
    region: process.env.VOLCENGINE_BGM_REGION?.trim() || DEFAULT_REGION,
    service: process.env.VOLCENGINE_BGM_SERVICE?.trim() || DEFAULT_SERVICE,
  }
}

/** 按风格随机取一条中文描述（池子多样性的来源） */
export function pickVolcanoPrompt(style: BgmStyle, index?: number): string {
  const pool = VOLCANO_BGM_PROMPTS[style]
  const at = index === undefined ? randomInt(pool.length) : index % pool.length
  return pool[at] ?? pool[0] ?? ''
}

/** 该风格预期生成的曲子时长（秒）。取满上限，既满足 ≥65s 又规避版权校验。 */
export function volcanoDurationForStyle(_style: BgmStyle): number {
  return VOLCANO_BGM_DEFAULT_SEC
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex')
}

function hmac(key: Buffer | string, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest()
}

/** UTC 的 `YYYYMMDD'T'HHMMSS'Z'` 与其短日期 `YYYYMMDD` */
export function volcanoDates(now: Date = new Date()): { xDate: string; shortDate: string } {
  const iso = now.toISOString().replace(/[-:]|\.\d{3}/g, '') // 20260928T040000Z
  return { xDate: iso, shortDate: iso.slice(0, 8) }
}

export interface VolcanoSignInput {
  action: string
  body: string
  xDate: string
  shortDate: string
  credentials: VolcanoBgmCredentials
}

export interface VolcanoSignResult {
  /** 直接可用的 Authorization 头 */
  authorization: string
  /** 参与签名的 header 列表（分号分隔，小写） */
  signedHeaders: string
  /** body 的 sha256（即 X-Content-Sha256 的值） */
  contentSha256: string
  /** 供排查：签名用的规范请求串，不含密钥，可安全打印 */
  canonicalRequest: string
}

/**
 * 火山 TopAPI v4 签名（AWS SigV4 风格）。**纯函数，便于自检。**
 *
 * 规范请求串（各项之间用 \n 连接）：
 *   METHOD\nCanonicalURI\nCanonicalQueryString\nCanonicalHeaders\nSignedHeaders\nHashedPayload
 * 待签串：
 *   HMAC-SHA256\n{X-Date}\n{ShortDate}/{Region}/{Service}/request\n{hash(规范请求串)}
 * 派生密钥：kDate=HMAC(SK,ShortDate) → kRegion=HMAC(kDate,Region) → kService=HMAC(kRegion,Service) → kSigning=HMAC(kService,"request")
 *
 * ★ 绝不把 secretKey 写进任何返回值或日志。
 */
export function signVolcanoRequest(input: VolcanoSignInput): VolcanoSignResult {
  const { action, body, xDate, shortDate, credentials } = input
  const { accessKey, secretKey, region, service } = credentials

  const contentSha256 = sha256Hex(body)
  const query = `Action=${action}&Version=${API_VERSION}`

  const canonicalHeaders =
    `content-type:application/json\n` + `host:${API_HOST}\n` + `x-content-sha256:${contentSha256}\n` + `x-date:${xDate}\n`
  const signedHeaders = 'content-type;host;x-content-sha256;x-date'

  const canonicalRequest = ['POST', '/', query, canonicalHeaders, signedHeaders, contentSha256].join('\n')

  const credentialScope = `${shortDate}/${region}/${service}/${REQUEST_TERMINATOR}`
  const stringToSign = ['HMAC-SHA256', xDate, credentialScope, sha256Hex(canonicalRequest)].join('\n')

  const kDate = hmac(secretKey, shortDate)
  const kRegion = hmac(kDate, region)
  const kService = hmac(kRegion, service)
  const kSigning = hmac(kService, REQUEST_TERMINATOR)
  const signature = createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex')

  return {
    authorization: `HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    signedHeaders,
    contentSha256,
    canonicalRequest,
  }
}

interface VolcanoApiResponse {
  Code?: number
  Message?: string
  Result?: {
    TaskID?: string
    PredictedWaitTime?: number
    Status?: number
    Progress?: number
    FailureReason?: { Code?: number | string; Msg?: string } | null
    SongDetail?: {
      AudioUrl?: string
      Duration?: number
      TosPath?: string
      Prompt?: string
    } | null
  }
  ResponseMetadata?: { RequestId?: string; Error?: { Code?: string; Message?: string } | null }
}

async function callVolcanoApi(
  action: string,
  body: Record<string, unknown>,
  credentials: VolcanoBgmCredentials,
  timeoutMs: number,
): Promise<VolcanoApiResponse> {
  const payload = JSON.stringify(body)
  const { xDate, shortDate } = volcanoDates()
  const signed = signVolcanoRequest({ action, body: payload, xDate, shortDate, credentials })

  const url = `https://${API_HOST}/?Action=${action}&Version=${API_VERSION}`
  const res = await safeFetch(
    url,
    {
      method: 'POST',
      headers: {
        Host: API_HOST,
        'Content-Type': 'application/json',
        'X-Date': xDate,
        'X-Content-Sha256': signed.contentSha256,
        Authorization: signed.authorization,
      },
      body: payload,
    },
    { timeoutMs },
  )

  const text = await res.text()
  if (!res.ok) throw new Error(`火山 ${action} HTTP ${res.status}：${text.slice(0, 400)}`)

  let parsed: VolcanoApiResponse
  try {
    parsed = JSON.parse(text) as VolcanoApiResponse
  } catch {
    throw new Error(`火山 ${action} 返回不是 JSON：${text.slice(0, 400)}`)
  }
  if (parsed.Code !== 0) {
    const hint =
      parsed.Code === 50000001
        ? '（版权校验拒绝：按文档建议丰富 Text、加长 Duration 后再试）'
        : ''
    throw new Error(`火山 ${action} Code=${parsed.Code} ${parsed.Message ?? ''}${hint}`)
  }
  return parsed
}

export interface SubmitVolcanoBgmInput {
  text: string
  durationSec?: number
  /** 可选：任务完成后会 POST 回调这个地址 */
  callbackUrl?: string
  /** 可选：把结果落到你自己的火山 TOS 桶 */
  tosBucket?: string
  timeoutMs?: number
}

/** 提交生成任务。返回 TaskID（**生成尚未完成**）。 */
export async function submitVolcanoBgm(input: SubmitVolcanoBgmInput): Promise<string> {
  const credentials = volcanoBgmCredentials()
  if (!credentials) {
    throw new Error(
      `未配置火山 AK/SK（缺 ${describeVolcanoBgmConfig().missing.join(' / ')}）—— 配乐生成源无法使用火山`,
    )
  }
  const durationSec = Math.min(VOLCANO_BGM_MAX_SEC, Math.max(VOLCANO_BGM_MIN_SEC, input.durationSec ?? VOLCANO_BGM_DEFAULT_SEC))

  const body: Record<string, unknown> = {
    Text: input.text,
    Duration: durationSec,
    Version: 'v5.0',
    EnableInputRewrite: false,
  }
  if (input.tosBucket) body.TosBucket = input.tosBucket
  if (input.callbackUrl) body.CallbackURL = input.callbackUrl

  const parsed = await callVolcanoApi('GenBGMForTime', body, credentials, input.timeoutMs ?? 60_000)
  const taskId = parsed.Result?.TaskID
  if (!taskId) throw new Error(`GenBGMForTime 未返回 TaskID：${JSON.stringify(parsed).slice(0, 400)}`)
  return taskId
}

export type VolcanoBgmStatus = 'PENDING' | 'RUNNING' | 'SUCCESS' | 'FAILED'

export interface VolcanoBgmTask {
  status: VolcanoBgmStatus
  progress: number
  audioUrl: string | null
  durationSec: number | null
  failure: string | null
}

/** 文档状态码：0 等待中 / 1 处理中 / 2 成功 / 3 失败 */
function normalizeStatus(code: number | undefined): VolcanoBgmStatus {
  if (code === 2) return 'SUCCESS'
  if (code === 3) return 'FAILED'
  if (code === 1) return 'RUNNING'
  return 'PENDING'
}

/** 查询任务。**查询本身不消耗生成额度**，可以放心轮询。 */
export async function queryVolcanoBgm(taskId: string, timeoutMs = 30_000): Promise<VolcanoBgmTask> {
  const credentials = volcanoBgmCredentials()
  if (!credentials) {
    throw new Error(`未配置火山 AK/SK（缺 ${describeVolcanoBgmConfig().missing.join(' / ')}）`)
  }
  const parsed = await callVolcanoApi('QuerySong', { TaskID: taskId }, credentials, timeoutMs)
  const result = parsed.Result ?? {}
  const detail = result.SongDetail ?? null
  const failure = result.FailureReason
  return {
    status: normalizeStatus(result.Status),
    progress: typeof result.Progress === 'number' ? result.Progress : 0,
    audioUrl: typeof detail?.AudioUrl === 'string' && detail.AudioUrl.trim() ? detail.AudioUrl.trim() : null,
    durationSec: typeof detail?.Duration === 'number' ? detail.Duration : null,
    failure: failure ? `${failure.Code ?? ''} ${failure.Msg ?? ''}`.trim() || '未知失败原因' : null,
  }
}

export interface GenerateVolcanoBgmInput extends SubmitVolcanoBgmInput {
  /** 轮询预算（秒），默认 420（实测同类接口 1~5 分钟） */
  waitSeconds?: number
  pollIntervalMs?: number
  onProgress?: (note: string) => void
}

export interface GenerateVolcanoBgmResult {
  bytes: Buffer
  contentType: string | null
  audioUrl: string
  durationSec: number | null
  taskId: string
}

/**
 * 一路做完：提交 → 轮询 → 下载音频字节。
 *
 * ★ 下载走 `safeFetch` 而不是裸 fetch：`AudioUrl` 是**远端返回的 URL**，
 *   属于不可信输入，必须过协议白名单 + 拒本机/私网 + 不跟随重定向。
 *   ⚠ 副作用：目标若返回 3xx 会被直接拒绝（这是刻意的安全取舍）。
 */
export async function generateVolcanoBgm(input: GenerateVolcanoBgmInput): Promise<GenerateVolcanoBgmResult> {
  const waitSeconds = input.waitSeconds ?? 420
  const pollIntervalMs = input.pollIntervalMs ?? 10_000
  const note = input.onProgress ?? (() => {})

  const taskId = await submitVolcanoBgm(input)
  note(`已提交 TaskID=${taskId}（预计等待 ${VOLCANO_BGM_DEFAULT_SEC}s 的曲子）`)

  const deadline = Date.now() + waitSeconds * 1000
  let last = 'PENDING'
  for (;;) {
    const task = await queryVolcanoBgm(taskId).catch((error: Error) => {
      // 单次查询失败不该立刻放弃：网络抖动很常见，继续轮询
      note(`查询失败（继续重试）：${error.message}`)
      return null
    })
    if (task) {
      if (task.status === 'FAILED') throw new Error(`火山生成失败（TaskID=${taskId}）：${task.failure ?? '未知原因'}`)
      if (task.status === 'SUCCESS') {
        if (!task.audioUrl) throw new Error(`火山任务成功但没给 AudioUrl（TaskID=${taskId}）`)
        note(`生成就绪（进度 ${task.progress}%），开始下载`)
        const res = await safeFetch(task.audioUrl, { method: 'GET' }, { timeoutMs: 180_000 })
        if (!res.ok) throw new Error(`下载生成的音频失败：HTTP ${res.status}`)
        const bytes = Buffer.from(await res.arrayBuffer())
        if (bytes.byteLength < 64 * 1024) {
          throw new Error(`下载到的文件只有 ${bytes.byteLength} 字节，明显不是一首曲子`)
        }
        return {
          bytes,
          contentType: res.headers.get('content-type'),
          audioUrl: task.audioUrl,
          durationSec: task.durationSec,
          taskId,
        }
      }
      if (task.status !== last) {
        note(`状态 ${task.status}（进度 ${task.progress}%）`)
        last = task.status
      }
    }
    if (Date.now() >= deadline) {
      throw new Error(`等待超时（${waitSeconds}s，TaskID=${taskId}）—— 生成可能仍在进行，稍后可用该 TaskID 手工查询`)
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs))
  }
}
