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
 * 容量上限：**表里有几条，池子就别超过几首**（当前每风格 100 条 ⇒ 池子目标也是 100）。
 *
 * 补货取词先挑「池里没用过的描述」，用尽之后就必然回头复用同一批描述 ⇒ 池内会出现
 * 「一条描述对应好几首」。代价**不是**曲子重复（同一段 Text 两次生成结果不同、没有 seed，
 * 2026-09-28 实测），而是 ①**选曲失去区分度**（`bgm_select` 看到的候选彼此无法区分）
 * ②**曲风单薄**（同一描述是同曲风的近似变体）。全程**不报任何错**。
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
    '温柔的长笛与钢琴二重奏纯音乐，气息绵长速度缓慢，情绪安宁，适合清晨备菜与开店准备镜头，全程没有人声',
    '轻盈的钢片琴与弦乐拨奏纯音乐，音色清冽有光感，适合鲜榨果汁与冰饮出杯镜头，全程没有人声',
    '舒缓的手风琴与低音提琴纯音乐，摇摆从容，带欧洲小镇气息，适合西餐与烘焙门店，全程没有人声',
    '安静的木吉他分解和弦纯音乐，配极轻的风铃点缀，留白充足，适合素雅门店的空镜与环境展示，全程没有人声',
    '温暖的尤克里里与口琴纯音乐，节奏轻晃，甜而清爽，适合甜品台与蛋糕裱花过程，全程没有人声',
    '恬淡的古筝与竹笛纯音乐，音符疏落，东方意境清雅，适合中式茶饮与禅意门店，全程没有人声',
    '轻柔的电钢琴与尼龙弦吉他纯音乐，速度中慢，松弛惬意，适合午后堂食与顾客闲聊，全程没有人声',
    '明净的钟琴与竖琴纯音乐，音色通透如水，适合冷萃咖啡与轻食摆盘，全程没有人声',
    '悠缓的大提琴与钢琴纯音乐，旋律内敛克制，适合店主自述与手作过程，全程没有人声',
    '轻巧的班卓琴与口哨纯音乐，田园气息浓节奏跳跃，适合农场直供与生鲜展示，全程没有人声',
    '柔和的萨克斯与电钢琴纯音乐，气声温润，适合小酒馆午后与咖啡时段，全程没有人声',
    '清新的手碟与雨棍纯音乐，音色空灵流动，适合轻食与沙拉制作镜头，全程没有人声',
    '温和的曼陀铃与木吉他纯音乐，节奏轻快有律动，适合早餐出摊与早点铺，全程没有人声',
    '舒缓的口琴与弦乐群纯音乐，情绪怀旧温暖，适合老店翻新与门头改造记录，全程没有人声',
    '简约的钢琴单音与低频铺底纯音乐，克制安静，适合素雅空间的空镜展示，全程没有人声',
    '轻盈的马林巴与沙锤纯音乐，颗粒明亮有弹性，适合水果拼盘与果茶制作，全程没有人声',
    '悠然的民谣吉他拨弦纯音乐，配轻手鼓点缀，叙事感强，适合门店一天的流水式记录，全程没有人声',
    '温润的竖琴与长笛纯音乐，旋律上行舒缓，适合花艺与茶饮门店的环境镜头，全程没有人声',
    '轻快的小提琴与钢琴纯音乐，弓法轻巧不炫技，适合家常菜出锅与摆盘，全程没有人声',
    '慵懒的低音贝斯与电钢琴纯音乐，速度缓慢放松，适合晚市收档与打扫镜头，全程没有人声',
    '素净的洞箫与古琴纯音乐，气韵悠长留白多，适合素食与养生餐饮，全程没有人声',
    '轻软的木琴与弦乐拨奏纯音乐，音色圆润，适合面包出炉与烘焙特写，全程没有人声',
    '温暖的吉他滑音与口琴纯音乐，带南方小镇气息，适合米粉与面馆日常，全程没有人声',
    '明快的钢片琴与木吉他纯音乐，节奏轻巧，适合饮品店出杯流水镜头，全程没有人声',
    '舒缓的琵琶与弦乐纯音乐，音色温婉，适合中式点心与早茶场景，全程没有人声',
    '恬静的钢琴与长号弱奏纯音乐，情绪沉稳柔和，适合私房菜与小型包间，全程没有人声',
    '轻快的口琴与拨弦贝斯纯音乐，节奏弹跳，适合小吃街与夜市摊位，全程没有人声',
    '柔美的双簧管与弦乐纯音乐，旋律清亮含蓄，适合季节限定与新品预告，全程没有人声',
    '温暖的手碟与尤克里里纯音乐，律动轻柔，适合周末集市与户外摊位，全程没有人声',
    '干净的吉他泛音与钢琴高音纯音乐，透明清澈，适合冰凉甜品与冰淇淋特写，全程没有人声',
    '舒缓的萨克斯与竖琴纯音乐，气声细腻，适合酒店餐饮与商务简餐，全程没有人声',
    '轻灵的拇指琴与弦乐垫底纯音乐，速度缓慢，适合亲子餐厅与儿童餐，全程没有人声',
    '明净的木吉他扫弦与铃鼓纯音乐，节奏从容有呼吸，适合社区小店日常，全程没有人声',
    '温存的电钢琴与长笛纯音乐，和声柔和，适合深夜食堂与夜宵收尾，全程没有人声',
    '清爽的原声贝斯与马林巴纯音乐，律动轻捷，适合凉菜与卤味展示，全程没有人声',
    '安静的钢琴与手风琴纯音乐，速度中慢，适合西式烘焙课堂与体验课，全程没有人声',
    '轻快的卡林巴与沙锤纯音乐，音色晶亮，适合花茶与果茶调制过程，全程没有人声',
    '悠扬的竹笛与古筝纯音乐，旋律舒展，适合江南菜与河鲜门店，全程没有人声',
    '温柔的弦乐四重奏纯音乐，力度克制不张扬，适合品牌门店日常的环境展示，全程没有人声',
    '闲适的口哨与木吉他纯音乐，市井又干净，适合早点与豆浆油条镜头，全程没有人声',
    '恬淡的竖琴与钢片琴纯音乐，音色透明，适合轻食沙拉与健康餐，全程没有人声',
    '轻软的合成器垫底与钢琴纯音乐，速度缓慢，适合门店灯光与空间细节，全程没有人声',
    '明快的曼陀铃与手鼓纯音乐，节奏轻跳，适合户外露营风餐饮，全程没有人声',
    '安逸的电吉他清音与钢琴纯音乐，音色温暖不失质感，适合咖啡与简餐门店，全程没有人声',
    '舒缓的尺八与弦乐纯音乐，气声悠远，适合日式料理与居酒屋，全程没有人声',
    '轻快的钢鼓与木吉他纯音乐，节奏律动温暖，适合热带风味与东南亚菜，全程没有人声',
    '温柔的钢琴与低音单簧管纯音乐，音色沉静，适合老字号与传承叙述，全程没有人声',
    '清新的尤克里里与口琴纯音乐，甜而不腻，适合奶茶与甜品出杯，全程没有人声',
    '宁静的氛围合成器与钢琴纯音乐，空间感柔和，适合门店环境与绿植展示，全程没有人声',
    '轻巧的木琴与口琴纯音乐，速度中快有弹性，适合快餐与简餐出餐，全程没有人声',
    '温润的吉他指弹与弦乐纯音乐，情绪柔和，适合手作菜品与匠人镜头，全程没有人声',
    '悠闲的萨克斯与吉他纯音乐，摇摆舒缓，适合西餐厅午餐时段，全程没有人声',
    '明亮的钢琴与手风琴纯音乐，节奏轻快，适合节假日门店氛围，全程没有人声',
    '柔和的雨棍与电钢琴纯音乐，音色安静绵长，适合雨天门店与窗边镜头，全程没有人声',
    '舒缓的箫与竖琴纯音乐，东方韵味清雅，适合茶室与禅意空间，全程没有人声',
    '轻快的口琴与手鼓纯音乐，节奏阳光，适合户外烧烤与露营餐饮，全程没有人声',
    '干净的钢琴与弦乐拨奏纯音乐，留白充足，适合菜肴特写与静态摆盘，全程没有人声',
    '温暖的吉他重奏与铃铛纯音乐，节日气氛柔和，适合节庆门店与装饰镜头，全程没有人声',
    '恬静的马林巴与弦乐纯音乐，音色圆润通透，适合水果茶与鲜果切，全程没有人声',
    '悠缓的低音提琴与钢琴纯音乐，情绪安定，适合高端素菜与私宴，全程没有人声',
    '轻盈的长笛与钢片琴纯音乐，音色清透，适合冰品与甜品台展示，全程没有人声',
    '安逸的口琴与尤克里里纯音乐，生活气息浓，适合夫妻小店日常记录，全程没有人声',
    '柔美的古琴与箫纯音乐，音色淡雅，适合中式茶点与文玩空间，全程没有人声',
    '轻快的采茶调纯音乐，笛子与三弦交替，田园气息浓，适合农家乐与采摘园，全程没有人声',
    '温润的电钢琴与单簧管纯音乐，旋律舒缓上行，适合早餐与晨间营业，全程没有人声',
    '闲雅的钢琴泛音与风铃纯音乐，安静悠长，适合午后空镜与光影变化，全程没有人声',
    '清爽的合成器琶音与木吉他纯音乐，节奏轻快，适合轻食与沙拉吧，全程没有人声',
    '温柔的双簧管与钢琴纯音乐，情绪含蓄，适合甜品与法式烘焙，全程没有人声',
    '恬适的手碟与弦乐垫底纯音乐，音色流动，适合轻养生与茶饮门店，全程没有人声',
    '明净的竖琴与木吉他纯音乐，节奏从容轻快，适合新店试营业与顾客入店镜头，全程没有人声',
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
    '明快的电子流行纯音乐，厚实底鼓配明亮主旋律，推进感强，适合菜品快剪与踩点剪辑，全程没有人声',
    '律动跳跃的放克纯音乐，切分吉他配贝斯走句，节奏弹性十足，适合翻炒与出锅镜头，全程没有人声',
    '欢快的合成器流行纯音乐，琶音明亮节奏轻快，适合新品上架与主推菜品，全程没有人声',
    '强劲的电子舞曲纯音乐，四踩底鼓配上扬副歌，情绪高涨，适合限时抢购与秒杀活动，全程没有人声',
    '弹跳的迪斯科纯音乐，弦乐断奏配拍手节奏，复古热闹，适合夜宵与酒水主推，全程没有人声',
    '带劲的电子摇滚纯音乐，失真吉他配密集鼓组，能量充沛，适合铁板与爆炒镜头，全程没有人声',
    '热带的雷鬼纯音乐，切分吉他配松弛鼓点，阳光随性，适合夏日冰品与冷饮促销，全程没有人声',
    '热烈的桑巴纯音乐，打击乐层层推进，适合堂食人多热闹场景，全程没有人声',
    '干脆的鼓打贝斯纯音乐，低频厚重节拍跳跃，适合出餐流水与快剪，全程没有人声',
    '喜庆的摇摆爵士纯音乐，铜管齐奏配钢琴切分，适合周年庆与开业活动，全程没有人声',
    '律动十足的电子放克纯音乐，合成器贝斯配拍手，适合门店活动与互动镜头，全程没有人声',
    '明快的口琴与鼓组纯音乐，节奏偏快有冲劲，适合外卖打包与出单镜头，全程没有人声',
    '活泼的木管与打击乐纯音乐，长笛短笛穿插，色彩明亮，适合亲子餐厅与儿童餐，全程没有人声',
    '劲爽的摇滚纯音乐，鼓组干净有力配贝斯走句，适合烧烤与串串类动感镜头，全程没有人声',
    '轻快的电子纯音乐，明亮主旋律配弹跳贝斯，适合促销海报与价格展示，全程没有人声',
    '跳跃的爵士放克纯音乐，电钢琴切分配铜管点缀，都市感强，适合商场餐饮门店，全程没有人声',
    '活力的乡村蓝草纯音乐，班卓与曼陀铃互答，热闹不拘，适合集市与摆摊记录，全程没有人声',
    '急促的拉丁打击纯音乐，康加鼓与沙锤层层推进，适合快节奏备菜与装盘，全程没有人声',
    '欢腾的中式打击纯音乐，锣鼓与唢呐点缀，热烈喜庆，适合开业庆典与年节促销，全程没有人声',
    '明快的合成器纯音乐，副歌旋律上扬，适合品牌活动与门店宣传，全程没有人声',
    '轻快的放克铜管纯音乐，小号与萨克斯互答，热闹有趣，适合探店与互动镜头，全程没有人声',
    '弹跳的芯片音色纯音乐，配轻快鼓组，俏皮活泼，适合趣味剪辑与转场，全程没有人声',
    '强节奏的电子铁克诺纯音乐，四踩底鼓配明亮合成器，适合运动感与快切镜头，全程没有人声',
    '欢快的手鼓与吉他纯音乐，节奏轻捷有呼吸，适合户外与露营风门店，全程没有人声',
    '劲爽的管乐进行曲纯音乐，长号与圆号齐奏，气势上扬，适合大促开场与门店迎宾，全程没有人声',
    '明快的朋克纯音乐，吉他扫弦干脆配疾速鼓点，冲劲十足，适合夜宵与酒水推荐，全程没有人声',
    '律动的放克摇滚纯音乐，节奏吉他切分配鼓组走句，适合动作感强的翻炒镜头，全程没有人声',
    '欢快的电子流行纯音乐，明亮合成器配拍手音色，适合菜品制作快剪，全程没有人声',
    '明快的迪斯科放克纯音乐，低音走句配弦乐断奏，复古时尚，适合酒水与咖啡特调，全程没有人声',
    '弹跳的合成器放克纯音乐，琶音明亮节奏紧凑，适合新品发布与限时优惠，全程没有人声',
    '活力的电子乡村纯音乐，班卓配电子鼓组，轻快朴实，适合农场直供与生鲜促销，全程没有人声',
    '热烈的非洲鼓纯音乐，多层打击交错推进，适合火锅与串串热闹场景，全程没有人声',
    '干脆的摇滚放克纯音乐，贝斯走句配铜管点缀，适合出餐快剪与节奏剪辑，全程没有人声',
    '明快的电子合成器纯音乐，音色明亮节奏弹跳，适合会员日与折扣活动，全程没有人声',
    '跳跃的复古摇摆纯音乐，铜管齐奏配刷鼓，适合品牌联名与快闪活动，全程没有人声',
    '劲道的嘻哈纯音乐，低沉鼓点配明亮键盘，适合门店日常流水记录，全程没有人声',
    '欢快的手风琴与鼓组纯音乐，节奏弹跳，适合节庆与庙会摊位，全程没有人声',
    '明快的电子摇滚纯音乐，合成器主旋律配失真节奏吉他，适合爆款菜品主推，全程没有人声',
    '律动的拉丁爵士纯音乐，钢琴切分配康加鼓，适合烤肉与巴西风味门店，全程没有人声',
    '欢快的电子民谣纯音乐，木吉他与合成器交织，节奏轻快，适合市集与户外摊位，全程没有人声',
    '热闹的进行曲纯音乐，铜管与鼓队齐步推进，适合开业巡游与门店庆典，全程没有人声',
    '明快的电音放克纯音乐，合成器贝斯配明亮主旋律，适合限时套餐与组合促销，全程没有人声',
    '活力的电子派对纯音乐，明亮琶音配弹跳底鼓，适合快闪与秒杀活动，全程没有人声',
    '跳跃的爵士摇摆纯音乐，钢琴与贝斯对答配鼓刷，适合咖啡馆与轻食门店，全程没有人声',
    '干脆的电子嘻哈纯音乐，紧凑鼓组配低音合成器，适合街头小吃与夜市，全程没有人声',
    '欢快的乡村放克纯音乐，班卓配切分吉他，朴实热闹，适合农家菜与土特产展示，全程没有人声',
    '明快的打击乐纯音乐，木琴与手鼓交错，颗粒感强，适合水果与果切类镜头，全程没有人声',
    '律动的电子迪斯科纯音乐，弦乐断奏配华丽合成器，适合夜场与餐吧氛围，全程没有人声',
    '弹跳的合成器摇滚纯音乐，主旋律上扬配鼓组推进，适合门店宣传与活动预告，全程没有人声',
    '活力的放克流行纯音乐，铜管点缀配节奏吉他，适合互动类与探店镜头，全程没有人声',
    '明快的电子纯音乐，铜管采样配弹跳贝斯，热闹有推进感，适合大促与满减活动，全程没有人声',
    '强劲的摇滚纯音乐，双吉他互答配密集鼓组，适合烤串与炭火镜头，全程没有人声',
    '欢快的雷鬼放克纯音乐，切分节奏配铜管点缀，热带随性，适合夏日饮品促销，全程没有人声',
    '轻快的电子摇摆舞曲纯音乐，铜管采样配弹跳底鼓，适合节庆派对与门店活动，全程没有人声',
    '明快的乡村民谣摇滚纯音乐，木吉他与电吉他互答，朴实热闹，适合市集与摆摊记录，全程没有人声',
    '热辣的拉丁流行纯音乐，打击乐配铜管点缀，节奏热烈，适合火锅与川菜门店，全程没有人声',
    '干脆的电子摇滚舞曲纯音乐，失真吉他配四踩底鼓，劲道十足，适合铁板与火焰镜头，全程没有人声',
    '轻快的木管与电子鼓纯音乐，长笛主旋律配弹跳节奏，适合新品与季节限定，全程没有人声',
    '律动的爵士嘻哈纯音乐，慵懒鼓点配温暖电钢琴，适合咖啡馆与书店餐饮，全程没有人声',
    '明快的电子放克摇滚纯音乐，合成器与失真吉他交织，适合品牌活动与快闪，全程没有人声',
    '欢快的口琴蓝调摇滚纯音乐，节奏轻快有摇摆感，适合烧烤与夜市摊位，全程没有人声',
    '活力的电子进行曲纯音乐，铜管与合成器齐奏，适合开业与周年庆，全程没有人声',
    '明快的迪斯科浩室纯音乐，四踩底鼓配弦乐断奏，适合夜场与餐吧主推，全程没有人声',
    '明快的打击乐流行纯音乐，钢鼓与手鼓交错，阳光轻快，适合东南亚菜与热带风味，全程没有人声',
    '强劲的电子摇滚纯音乐，厚重合成器配密集鼓组，适合爆炒与出锅快剪，全程没有人声',
    '欢快的乡村乐队纯音乐，班卓与口琴互答，节奏轻快，适合农家乐与采摘园，全程没有人声',
    '律动的电子爵士纯音乐，电钢琴切分配电子鼓组，都市感强，适合商场餐饮门店，全程没有人声',
    '明快的合成器摇滚纯音乐，琶音主旋律配上扬副歌，适合品牌宣传与门店活动，全程没有人声',
    '弹跳的电子放克舞曲纯音乐，贝斯走句配拍手节奏，适合限时折扣与秒杀，全程没有人声',
    '活力的摇滚进行曲纯音乐，吉他扫弦配鼓队推进，气势上扬，适合大促开场与排队场景，全程没有人声',
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
    '沉稳大气的交响纯音乐，弦乐与木管交替铺陈，气势开阔，适合品牌形象片开场，全程没有人声',
    '高级质感的钢琴独奏纯音乐，和声克制留白充足，适合菜品特写与静态摆盘，全程没有人声',
    '优雅的弦乐与竖琴纯音乐，旋律舒缓上行，气质端方，适合高端宴席与商务宴请，全程没有人声',
    '内敛的室内乐纯音乐，弦乐四重奏质感细腻考究，适合私房菜与精品门店，全程没有人声',
    '开阔的氛围电子纯音乐，低频缓慢铺底配空灵音色，空间感强，适合门店环境与灯光展示，全程没有人声',
    '庄重的管弦纯音乐，铜管与定音鼓点缀，气势沉稳，适合连锁品牌与规模展示，全程没有人声',
    '中式意境的古琴与箫纯音乐，音符疏落留白多，气韵悠长，适合高端中式餐饮，全程没有人声',
    '电影感的钢琴与弦乐纯音乐，由缓入强再收，情绪完整，适合门店故事短片，全程没有人声',
    '温厚的大提琴与低音提琴纯音乐，旋律平稳下行，安定可靠，适合老字号与传承叙述，全程没有人声',
    '华美的弦乐与长笛纯音乐，旋律婉转向上，适合品牌新品发布，全程没有人声',
    '极简的氛围电子纯音乐，脉冲式音色配干净低频，克制有力，适合科技感门店形象片，全程没有人声',
    '沉浸的钢琴与氛围合成器纯音乐，音色通透悠远，适合茶室与空间细节，全程没有人声',
    '恢宏的交响铜管纯音乐，齐奏层层推进，仪式感强，适合品牌里程碑短片，全程没有人声',
    '雅致的琵琶与弦乐纯音乐，音色温润含蓄，适合中式正餐与宴请，全程没有人声',
    '肃穆的大提琴慢板纯音乐，单声部低沉铺陈，情绪饱满，适合品质承诺与匠人镜头，全程没有人声',
    '高级的爵士三重奏纯音乐，钢琴贝斯鼓组细腻呼应，格调从容，适合酒类与高端酒水主推，全程没有人声',
    '悠远的洞箫与弦乐群纯音乐，气声细腻意境深远，适合高端茶饮与中式点心，全程没有人声',
    '清冷的氛围钢琴纯音乐，高音区稀疏配低沉铺底，克制疏离，适合极简风格门店，全程没有人声',
    '大气的弦乐与电子混合纯音乐，低频空间感强配空灵高音，适合航拍与门头远景，全程没有人声',
    '沉稳的管弦纯音乐，低音弦乐垫底配弱音铜管，厚重有力，适合品牌实力展示，全程没有人声',
    '精致的竖琴独奏纯音乐，音色华美流畅，适合高端甜品与下午茶，全程没有人声',
    '寂静的氛围吉他纯音乐，加入细微弦乐铺底，安静而高级，适合菜品摆盘与特写，全程没有人声',
    '庄严的颂歌纯音乐，弦乐与铜管层层铺开，温暖肃穆，适合周年与感恩主题，全程没有人声',
    '通透的钢琴与古筝纯音乐，线条清雅含蓄，适合高端中式茶饮，全程没有人声',
    '辽阔的弦乐纯音乐，旋律开阔舒展，适合门店空间与环境展示，全程没有人声',
    '现代的极简电子纯音乐，干净留白配低频脉冲，适合科技感与设计感门店，全程没有人声',
    '沉静的大提琴独奏纯音乐，情绪深沉内敛，适合创始人心路讲述，全程没有人声',
    '华丽的管弦纯音乐，弦乐与木管交织推进，适合品牌宣传片高潮，全程没有人声',
    '温润的钢琴三重奏纯音乐，室内乐质感细腻，适合私宴与商务包间，全程没有人声',
    '空灵的氛围合成器纯音乐，音色流动空间开阔，适合养生餐饮与冥想空间，全程没有人声',
    '典雅的中式管弦纯音乐，竹笛与琵琶交替配弦乐衬底，东方意境，适合中式宴请场景，全程没有人声',
    '持重的弦乐与管风琴纯音乐，缓慢铺陈仪式感强，适合品牌溯源与历史叙述，全程没有人声',
    '纯净的钢琴独奏纯音乐，单音线条干净留白多，适合极简菜品与静态特写，全程没有人声',
    '宽广的弦乐与合成器纯音乐，低频缓动配空灵高音，适合环境与空间展示，全程没有人声',
    '温雅的竖琴与长笛纯音乐，旋律轻缓上行，适合高端甜品与下午茶，全程没有人声',
    '厚重的交响纯音乐，低音弦乐与定音鼓铺陈，气势沉稳，适合品牌实力与规模展示，全程没有人声',
    '清雅的箫与古琴纯音乐，气韵悠长留白充足，适合茶室与禅意空间，全程没有人声',
    '内省的氛围钢琴纯音乐，和声丰富情绪克制，适合店主自述与品牌独白，全程没有人声',
    '优雅的弦乐小快板纯音乐，节奏轻捷不失稳重，适合品牌季节限定发布，全程没有人声',
    '沉郁的大提琴与弦乐群纯音乐，旋律缓缓上行，安定厚重，适合连锁品牌与标准流程，全程没有人声',
    '高级的氛围电子纯音乐，低频垫底配空灵高音，空间感强，适合门店环境与装修展示，全程没有人声',
    '庄重的管风琴与弦乐纯音乐，和声厚重缓慢推进，适合品牌纪念与里程碑，全程没有人声',
    '通透的钢琴与长笛二重奏纯音乐，线条清雅，适合茶室与高端中式餐饮，全程没有人声',
    '恢宏的电影配乐纯音乐，弦乐与铜管层层堆叠，张力强，适合品牌形象片高潮段，全程没有人声',
    '安详的原声吉他纯音乐，配极轻的环境铺底，适合高端食材与产地展示，全程没有人声',
    '优雅的室内乐纯音乐，弦乐与钢琴细腻呼应，适合私房菜与精品门店，全程没有人声',
    '深远的洞箫与弦乐群纯音乐，意境悠长，适合高端中式点心与茶饮，全程没有人声',
    '冷冽的氛围电子纯音乐，低频脉动配空灵音色，适合极简与设计感门店，全程没有人声',
    '华贵的大提琴与竖琴纯音乐，音色温润流畅，适合高端酒水与宴席，全程没有人声',
    '开阔的弦乐与木管纯音乐，旋律舒展上行，适合品牌年度回顾，全程没有人声',
    '静雅的钢琴与弦乐纯音乐，力度克制留白充足，适合菜肴特写与静态画面，全程没有人声',
    '沉静的颂歌纯音乐，弦乐与铜管温和铺开，庄严温暖，适合感恩与周年主题，全程没有人声',
    '精致的爵士钢琴纯音乐，和声丰富配低音贝斯轻走，适合高端酒水与餐吧，全程没有人声',
    '悠长的古筝与弦乐纯音乐，音符疏落意境深远，适合中式茶饮与点心，全程没有人声',
    '恢宏的管弦纯音乐，弦乐与打击层层递进，气势磅礴，适合品牌宣传与规模展示，全程没有人声',
    '温厚的钢琴与中提琴纯音乐，旋律平稳内敛，适合匠人镜头与传承叙述，全程没有人声',
    '透明的氛围合成器纯音乐，音色纯净空间开阔，适合新店环境与空间展示，全程没有人声',
    '端庄的室内乐纯音乐，钢琴与小提琴细腻呼应，适合高端宴请与商务宴会，全程没有人声',
    '沉稳的钢琴与大提琴纯音乐，情绪内敛厚重，适合品牌创始人与门店故事，全程没有人声',
    '壮阔的交响纯音乐，铜管与弦乐呼应推进，气势恢宏，适合品牌宣传片收尾，全程没有人声',
    '清雅的古琴与竹笛纯音乐，音色淡雅留白多，适合中式禅意与茶道空间，全程没有人声',
    '高级的氛围电子纯音乐，低频缓动配通透高音，适合酒店餐饮与空间展示，全程没有人声',
    '温雅的弦乐三重奏纯音乐，声部交错层次分明，适合精品门店与私房菜，全程没有人声',
    '悠远的中式管弦纯音乐，洞箫与古筝配弦乐衬底，东方意境，适合中式正餐与宴请，全程没有人声',
    '庄重的管弦慢板纯音乐，木管与弦乐交替推进，气息绵长，适合品牌年度总结与表彰，全程没有人声',
    '纯净的钢琴与弦乐纯音乐，由缓入强再收，适合门店故事短片高潮，全程没有人声',
    '辽阔的氛围钢琴纯音乐，音色通透空间感强，适合航拍与远景镜头，全程没有人声',
    '雅致的弦乐与古琴纯音乐，旋律含蓄悠长，适合茶饮与素食品牌，全程没有人声',
    '高级的室内乐纯音乐，大提琴与小提琴细腻对话，适合私宴与商务宴请，全程没有人声',
    '悠长的弦乐与钢琴纯音乐，旋律缓缓收束，余韵深远，适合品牌形象片收尾，全程没有人声',
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

/**
 * ★★ 火山「额度／开通」类错误码 —— 命中这些，**再试下一首也只会得到同一个错**。
 *
 *   官方错误码表（「音视频理解与处理 → 常见错误码」）：
 *     200022 APIOutOfLimit       用户可用资源包消耗完毕
 *     200023 APIOutOfQps         api 调用超过 qps 限制（要更多 QPS 须联系火山商务）
 *     200024 AuthDisable         账号的音乐功能被禁用
 *     200026 TosBucketLimit      tos 桶名称无效（结果同样是「生成不出来」，一并当致命）
 *     200027 APIOutOfTime        资源包过期
 *     200028 APINoSource         没有可用资源包
 *     200030 ServiceNotActivated 服务未开通
 *
 *   ★★ 为什么必须单独识别它们：补货循环是「失败就换下一条描述继续」，
 *     而这类错误**立刻返回**、循环里**没有任何间隔** ⇒ 会把该风格剩余的整个 `--max` 预算
 *     在**几秒内**全烧掉。日志看上去像「试了 28 次都失败、每首都有独立的错」，
 *     实际只是**同一个原因重复了 28 次**，而且把本该留给下次的机会用光了。
 *   ★ 实测（2026-09-28）：一轮 84 次机会里 70 次是这样烧掉的；前 14 首**连续成功**。
 *     ⇒ 典型形态是「**先连续成功若干首，然后全部失败**」，这与「请求发得太快」是两回事，
 *       别把根因误判成并发。
 *   ⇒ 调用方应当**立刻中止整轮**，去控制台/商务侧确认资源包与开通状态，而不是继续耗机会。
 */
export const VOLCANO_FATAL_ERROR_CODES = [200022, 200023, 200024, 200026, 200027, 200028, 200030] as const

/** 该错误串是否属于「额度／开通」类致命错误（形如 `火山 GenBGMForTime Code=200030 ServiceNotActivated`） */
export function isVolcanoFatalError(message: string): boolean {
  // ★ 用「后面不能再跟数字」的断言，而不是朴素 includes：`Code=200023` 是 `Code=2000230` 的前缀，
  //   朴素匹配会把更长的错误码（将来新增的 2000230）误判成 200023 —— 用错判据的代价是
  //   「一首生成不出来就中止整轮」，池子从此不再生长，而且**不报错**。
  return VOLCANO_FATAL_ERROR_CODES.some((code) => new RegExp(`Code=${code}(?![0-9])`).test(message))
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
