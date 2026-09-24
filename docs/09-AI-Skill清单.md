# 详细设计 09 · 系统 AI Skill 全景清单

> 项目：大帅餐饮短视频创作工具　|　版本：v1.0　|　更新：2026-09-13
> 目的：梳理整个系统里「应该用到」的 AI 能力清单，明确哪些已上线、哪些待开发，以及每项的触发入口、变量、计费与降级策略。

---

## 0. 什么是本系统里的 Skill

本系统不引入外部 Agent 框架，"Skill" 的落地载体就是 **`AiScene`（AI 场景）**：

- 一条 `ai_scene` 记录 = 一个 Skill，包含：提示词模板、变量占位符、默认模型、备用模型链、兜底模板、超时、重试次数、温度、输出上限、冻结上限。
- 业务层只传 `sceneCode` + 变量字典，**永不直接引用具体模型**；提示词与模型全部后台可配，改配置不发版。
- 统一由 `AiGateway.runScene()` 执行：候选链依次尝试 → 失败重试 → 熔断跳过 → 全失败返回兜底模板（不扣积分）。
- 配置入口：管理后台 → **AI 场景** 页（`apps/admin/src/pages/AiScenes.tsx`）。

```
业务调用方 → sceneCode + variables
                    ↓
            runBilledScene（冻结积分 → 调用 → 结算/解冻）
                    ↓
            AiGateway（候选链 / 熔断 / 成本核算 / 调用日志）
                    ↓
        默认模型 → 备用模型 → 兜底模板
```

---

## 1. 已接入 AI 场景（核心创作场景）

> ★ 2026-09-21 新增第 1.3 组「发布素材」2 个场景（`publish_material` / `publish_cover`），
> 均由「合成成片」页驱动。§1.1 / §1.2 为原有 5 个。

### 1.1 文案创作组

| Skill（sceneCode） | 中文名 | 定位 | 触发入口 |
|---|---|---|---|
| `copy_traffic` | 文案 · 流量款 | 餐饮账号话题；基于输入方向自然表达，不编本地身份、经历或热点 | 编辑页「流量款」卡片 |
| `copy_persona` | 文案 · 人设型 | 老板真实的做事方式与立场，不补编人生故事 | 编辑页「人设型」卡片 |
| `copy_knowledge` | 文案 · 干货型 | 一个有依据、讲得明白的餐饮常识，不冒充本店工艺 | 编辑页「干货型」卡片 |
| `copy_product` | 文案 · 产品型 | 讲清实际在售内容；价格、份量和套餐信息只按输入 | 编辑页「产品型」卡片 |
| `copy_recommend` | 文案 · 种草型 | 老板本人讲一个有依据的推荐理由，不伪装成顾客 | 编辑页「种草型」卡片 |
| `copy_generate` | 文案 · 通用版 | 兼容旧客户端；款式场景缺失/停用时的回退目标 | 旧客户端 / 容错回退 |

- 接口：`POST /creations/:id/copy`（入参 `track`，返回 `track` / `trackLabel`）
- 变量：`{{storeName}} {{category}} {{city}} {{dishName}} {{dishIntro}} {{sellingPoints}} {{persona}} {{copyText}} {{track}} {{trackLabel}}`
- 冻结上限：5 积分 / 次（`beanPrice`，非标价）
- 容错：款式对应场景不存在或被停用 → 自动回退 `copy_generate`，不报错

### 1.2 分镜脚本组

| Skill（sceneCode） | 中文名 | 定位 | 触发入口 |
|---|---|---|---|
| `storyboard_generate` | 分镜脚本生成 | 以复杂度镜头数为目标，台词逐字对齐，优先匹配单人、手机可拍的真实画面 | 编辑页「生成分镜」 |

- 接口：`POST /creations/:id/storyboard`（入参 `complexity`）
- 变量：在文案变量基础上增加 `{{complexity}} {{complexityLabel}} {{shotCountRule}} {{shotLibrary}}`
- 复杂度规则：`SIMPLE` 2~3 镜 / `COMPLEX` 5~6 镜 / `FINE` 6~9 镜，经 `{{shotCountRule}}` 注入
- 输出：JSON 数组，字段 `seq / shotType / shotSize / durationSuggest / line / visualReq / libraryCode`
- 冻结上限：10 积分 / 次

### 1.3 发布素材组（2026-09-21 新增）

面向「合成成片」完成后的**发布环节**：从已生成的口播文案反推一套可直接发布到短视频平台的素材
（标题 + 封面 + 文案）。**两条 Skill 串成一条链**：文本先跑，把封面画面描述交给图像场景。

```
口播文案 ──► publish_material（文本）──► { title, caption, coverPrompt }
                                              │
                                              └──► publish_cover（图像）──► 3:4 竖版封面
```

| Skill（sceneCode） | 中文名 | 类型 | 定位 | 触发入口 |
|---|---|---|---|---|
| `publish_material` | 发布素材 · 标题 / 文案 / 封面画面描述 | 文本 | 读口播文案，产出 1 个带钩子的标题 + 分段文案（含话题标签）+ 一段**给图像模型看的**画面描述 | 合成成片页「发布素材」卡片 |
| `publish_cover` | 发布素材 · 封面图 | **图像** | 吃上一步的 `coverPrompt` 出图，**3:4 竖版** | 同上；封面失败可单独重出 |

- 接口：`POST /creations/:id/publish-material`
  - 入参 `requestId`（幂等键，**每次点生成都要换新的**，复用会命中幂等直接返回上次结果）+ `part`
  - `part = ALL`（默认）：标题 + 文案 + 封面一次跑完
  - `part = COVER`：**只重出封面**，标题与文案沿用库里已有的，不会再调文本场景、不会重复扣文本那笔钱
- 读接口：`GET /creations/:id/publish-material`
  ★ **不校验会员**（与写接口刻意不同）：会员到期后仍能查看已生成的内容，否则等于「续费才能看自己买过的东西」。
- 变量：
  - `publish_material`：在文案变量（`{{storeName}} {{dishName}} {{copyText}}` …）基础上增加 `{{copyText}}` 即可用
  - `publish_cover`：**只有** `{{coverPrompt}}`。刻意**不给**它门店 / 菜品变量 ——
    封面提示词是「画面描述」而不是「营销文案」，把素材参数塞进图像模板只会让出图跑偏
- 真实调用链的幂等键：文本用 `{requestId}`、封面用 `{requestId}-cover`
  （两个场景是两笔独立业务请求，共用同一个 id 只会在排查时让人误以为是同一次调用）
- 计费：**两笔独立费用**，见 §4「图像 Skill 的固定价」
- 失败策略（这是本组的设计重点）：
  - **封面失败不拖垮标题 / 文案**：封面挂了仍返回可用标题与文案，另带 `coverError` 说明原因
  - 文本降级（走兜底模板 / 模型回了没法解析的内容）⇒ `degraded = true` + `notice`，
    并用口播文案**本地拼一版**标题与文案，用户拿到的是能用的东西而不是一个报错
  - 图像场景走兜底模板时**必须抛错**：兜底模板渲染出来的是「一段画面描述文字」，
    若当成图片地址往下传，报错会出现在十万八千里外的「下载封面失败」处
- 默认模型：`publish_material` → 文本主链；`publish_cover` → **只能**绑 `capability = 'IMAGE'` 的模型
- 落库：`creation_publish_material`（`creationId` **唯一** ⇒ 「每个创作一份」，重新生成＝覆盖同一行）
- 后台：本组在「AI 场景」页有独立分组「发布素材」，列表有「类型」列；
  编辑弹窗里图像场景的模型下拉**只列图像能力模型**（绑错＝每个候选都被网关跳过＝静默降级）

### 1.4 模型绑定策略（脚本自动维护）

`prisma/seed.ts` 在写入场景时按以下优先级绑定模型：

1. 取**全部「已启用的真实模型」**（`provider.enabled = true` 且 `protocol != 'MOCK'`），按 id 升序
2. 第一个作为所有场景的 `defaultModelId`，其余依次进入 `fallbackModelIds`（真实通道之间互相兜底）
3. ★ **一个真实模型都没有 ⇒ 直接 throw 中止**（不再退回 MOCK）

> ★ 2026-09-21 补充：**文本场景的绑定还多一道 `capability = 'TEXT'` 过滤**（`seedAi()` 的
> `realModels` 查询）。没有这道过滤时，库里一旦存在**出图模型**（`capability = 'IMAGE'`），
> 它会被当成「第一个真实模型」排到**所有文本场景**的主候选位；而网关的候选链是按能力闸门筛的
> ⇒ 每个文本场景的首选都必然被跳过。真实绑定关系由 `scripts/setup-ai-channels.ts` 按**通道**维护。

> ★ 2026-09-21 变更：**MOCK 通道已从 seed 整块移除**，第 3 条不再是「退回
> `mock-chat` / `mock-reasoner` 保证链路可跑」。原因是 MOCK 适配器**不发网络请求、直接返回样例文案**
> ⇒ 一旦真实通道全挂，商户拿到的是一段看起来正常、实际是占位样例的「文案」且照常走扣费链路；
> 而 seed 用的是 upsert + `enabled: true`，任何人在**生产库**跑一次 `db:seed` 都会覆盖真实通道链
> 并把 MOCK 重新点亮。没有 Key 的环境**允许 AI 直接失败**（落兜底模板、不扣积分），这比返回假文案正确。

当前配置策略：全部 11 个场景绑定 tokenbox 三通道链
（`gpt-5.5` → `claude-sonnet-5` → `deepseek-v4-flash`；`storyboard_generate` 另有一套，见下）。`storyboard_generate` 的候选链是
`deepseek-v4-flash` → `claude-sonnet-5`，**链里没有 GPT**（长输出稳定 125s 后被上游 524 掐断，
留着只是白等一个超时），超时 150s、不重试（单次尝试约 100s，重试代价大于换通道）。

> ⚠ 踩坑记录（历史）：此前 5 个场景的默认模型全部指向已停用的 MOCK 通道，且真实可用的 `gpt-5.6-sol` 未被任何场景引用，导致每次生成都直接落到兜底模板（前端提示「AI 繁忙，已用兜底文案」）。
> 根因是 `scripts/setup-gpt5sol.ts` 只覆盖了 2 个场景，后续新增的文案三款没同步绑定。
> ★ 该脚本已于 2026-09-21 **废弃**（现在运行会直接抛错，因为它会把 MOCK 写回兜底位）；
> 绑定关系现在统一由 `server/scripts/setup-ai-channels.ts` 维护。

---

## 2. 已注册 · 待接入 Skill（5 个）

来源：`docs/06-全链路梳理与三档生成方案.md` 第 3.2 节。定位是 **AI 生成（aiMode=true）合成链路的增强步骤**，每步独立成场景、独立计费、独立降级，坏一步不阻塞整链。

> ★ 与 §1.3 的边界（避免重复建设）：`title_overlay` 产出的是**视频内的贴片**
> （抽帧后烧进画面的主标题 / 角标），属于**合成**链路；`publish_material` 产出的是
> **发布到平台时填的**标题与文案，属于**发布**环节。两者作用域不同，不是一回事。

> 状态（2026-09-13）：5 个场景已写入 `prisma/seed.ts` 并在后台「AI 场景」页可见、可编辑提示词（名称带「待接入」标记）。
> 尚未有业务调用方，因此不会产生费用；worker 侧接入后即自动生效。

| Skill（sceneCode） | 中文名 | 作用 | 接入位置 | 建议输出 |
|---|---|---|---|---|
| `script_polish` | 文案润色成口播稿 | 把营销文案改写成可直接念的口播稿，按分镜时长控字数 | `applyAiSynthesis` 之前 | 纯文本（口播稿） |
| `bgm_select` | BGM 智能选择 | 按菜品品类 / 情绪标签从曲库挑曲目 | 合成前 | 曲库 ID + 建议音量 |
| `rhythm_detect` | 节奏点检测 | 输出卡点时间轴，供 FFmpeg 做节拍对齐 | 合成中 | 时间点数组 |
| `title_overlay` | 封面标题 / 贴片文案 | 生成封面主标题、副标题、角标短句 | 封面抽帧后 | 标题 + 贴片短句 |
| `review_guard` | 内容安全审校 | 过滤违规词后再进入配音 / 发布，规避合规风险 | 配音之前 | 通过 / 命中词 + 建议改写 |

### 2.1 建议实施顺序

1. `script_polish` —— 直接提升口播质量，改动最小（只加一次 AI 调用）
2. `review_guard` —— 合规刚需，越早上越好（生成式 AI 内容面向 C 端）
3. `title_overlay` —— 提升封面点击率，独立于合成链路
4. `bgm_select` —— 需要先有曲库数据
5. `rhythm_detect` —— 技术复杂度最高，放最后

---

## 3. 关联能力（非 AiScene，独立配置）

这些不是「场景」，但同属 AI 能力域，配置入口独立：

| 能力 | 配置入口 | 说明 |
|---|---|---|
| TTS 配音 | 后台「TTS 供应商」页（`TtsProviders.tsx` / `tts_provider` 表） | 独立于 AI 网关的供应商体系；未配置真实服务时合成链路退化为等长静音轨 |
| 通道测试 | 后台「AI 供应商」页一键测试 | `PROVIDER_TEST` / `TEST` 是系统内置的探测场景，非业务 Skill；发 `ping` 极短请求，不参与毛利统计、不影响熔断 |

---

## 4. 计费与降级规则（所有 Skill 通用）

| 情况 | 是否扣积分 | 说明 |
|---|---|---|
| 默认模型成功 | 扣 | 按实际成本 × `bean.cost_multiplier` 结算 |
| 备用模型成功 | 扣 | 用户无感，记入毛利报表（`isFallback=1`） |
| 全部失败 → 兜底模板 | **不扣** | 全额解冻，前端提示「AI 繁忙，已用兜底文案」 |
| 请求超时 | **不扣** | 全额解冻 |
| 幂等命中（重复 requestId） | 不重复扣 | 返回首次结果 |
| **图像 Skill 成功**（`kind = 'IMAGE'`） | 扣 | ★ **固定价**结算：`beanPrice` 就是报价本身，**与 token 用量无关**（原因见下） |

- `AiScene.beanPrice` = **单次冻结上限**（财务安全网），不是标价。
- 每个 Skill **必须配兜底模板**，保证通道全挂时流程不断。

### 4.1 图像 Skill 的固定价（`kind = 'IMAGE'`）

文本 Skill 按 token 成本结算，图像 Skill **必须按固定价**，原因是出图接口的返回里
**没有可用的 token 用量**（`usage: null`）—— 按成本公式算会得到 0 积分，
等于平台每出一张封面都全额补贴。所以图像场景的 `beanPrice` 同时承担两个角色：
**冻结上限** 与 **实际报价**（网关把它作为 `fixedBeans` 回传给结算层）。

`publish_cover` 的报价推导（定价依据是**实测**不是价目表）：

| 项 | 值 | 来源 |
|---|---|---|
| 上游实扣 | **$0.10 / 张** | `GET /dashboard/billing/usage` 前后差值（单位是美分，84 → 94） |
| 折人民币 | 0.10 × 7.2 = ¥0.72 | 汇率按 7.2 |
| 折分 | 72 分 | × 100 |
| 折积分 | 0.72 × 100(分/元) × 4(`cost_multiplier`) / 100 = **288** | 与文本同一套换算 |
| 取值 | **300** | 向上取整（余量 >3%，覆盖汇率波动） |

> ⚠ 三处必须同时改：`prisma/prompts.ts` 的 `PUBLISH_SCENES[*].beanPrice`、
> 库里的 `ai_scene.beanPrice`（`TB_SET_CAPS=1` 写库）、本节表格。
> ⚠ 模型码是裸 **`gpt-image-2`**，不是 `-1k` 变体：`-1k` 会以
> `image size "1024x1365" exceeds channel resolution limit 1k` 拒掉 3:4 尺寸，
> 且只返回 base64、耗时翻倍。

---

## 5. 后台可配项（每个 Skill 独立）

| 配置项 | 说明 |
|---|---|
| 场景类型 | `kind`：`TEXT`（chat/completions）或 `IMAGE`（images/generations）。**只读**：它决定调用哪个接口、候选池按哪个能力筛、以及**按成本还是按固定价**结算 |
| 提示词模板 | 支持 `{{变量}}` 占位符 |
| 兜底模板 | 全通道失败时的静态输出，同样支持变量 |
| 默认模型 | 首选执行模型 |
| 备用模型链 | 默认失败后按序尝试 |
| 温度 | 0~1，越高越随机 |
| 输出上限 | `maxOutputTokens` |
| 超时 / 重试 | `timeoutMs` / `maxRetries` |
| 冻结上限 | `beanPrice`；★ 图像场景它**同时就是报价**（见 §4.1） |
| 启用开关 | 停用后业务层回退或报错 |

---

## 6. 涉及文件

**服务端**
- `prisma/schema.prisma`（`AiScene` / `AiModel` / `AiProvider` / `AiCallLog`）
- `prisma/prompts.ts`（**提示词的唯一来源**：模板 / 兜底模板 / 冻结上限 / 场景类型，`npm run ai-prompts:sync` 据此洗库）
- `prisma/seed.ts`（内置场景的建行与模型绑定；提示词正文本身在 `prompts.ts`）
- `src/ai/gateway.ts`（候选链 / 熔断 / 成本核算）
- `src/ai/ai.service.ts`（`runBilledScene`：冻结 → 调用 → 结算/解冻）
- `src/ai/adapters.ts`（`OPENAI_COMPATIBLE` / `ANTHROPIC_NATIVE` / `MOCK` 协议适配；`openaiImage` 走 `images/generations`，兼容 `url` 与 `b64_json` 两种返回）
- `src/ai/scene-codes.ts` / `src/ai/prompt-vars.ts`（场景常量 / 变量白名单，新增场景两处都要登记）
- `src/services/creation.service.ts`（`COPY_TRACKS` / `COMPLEXITIES` / 场景解析）
- `src/services/publish-material.service.ts`（发布素材组编排：文本 → 封面 → 落库 → 独立计费）
- `src/services/remote-asset.service.ts`（远程图取回本地：出网守卫 + `curl` + 魔数校验，出图链路专用）
- `src/routes/creations.ts`（`GET/POST /creations/:id/publish-material`）
- `src/services/admin-ai.service.ts`（场景 CRUD；`sceneView` 透出 `kind` 供后台区分文本/图像）

**后台**
- `src/pages/AiScenes.tsx`（场景列表 + 多行提示词编辑；分组含「发布素材」，列表带「类型」列，
  编辑弹窗按 `kind` 过滤模型候选池）
- `src/pages/AiProviders.tsx` / `AiModels.tsx` / `AiCallLogs.tsx` / `TtsProviders.tsx`

**小程序**
- `src/services/creation.ts`（`generateCopy` / `generateStoryboard`）
- `src/services/publish-material.ts`（`getPublishMaterial` / `generatePublishMaterial`；超时 300s）
- `src/pages/creation/edit.tsx`（款式 / 复杂度卡片 + 生成按钮）
- `src/pages/render/compose.tsx`（合成成片页：分镜折叠与就地放大、发布素材卡片、成片记录入口）
- `src/pages/render/result.tsx`（成片记录详情页：视频保存到相册 + 封面 / 标题 / 文案）

---

## 7. 新增一个 Skill 的标准步骤

1. 在 `prisma/prompts.ts` 里定义模板 / 兜底模板 / 冻结上限 / **场景类型**，并加进导出的场景清单
2. 在 `src/ai/scene-codes.ts` 加常量并加进 `LIVE_SCENE_CODES`（进了才算「已接入业务」）
3. 若模板带变量，登记 `src/ai/prompt-vars.ts` 的 `SCENE_VARIABLES`
   （不登记 ⇒ 运行时变量被**静默替换成空串**、不报错但照常扣积分）
4. 建行 / 洗库：`npm run ai-prompts:sync`
   ★ **不要用 `npm run db:seed`**：seed 是 upsert + `enabled: true`，会**覆盖后台运营改过的提示词与通道链**；
   sync 只按代码更新模板，且**缺行会建行**（这是新增场景在生产上的唯一通道）
5. 出图类场景额外一步：库里必须有 `capability = 'IMAGE'` 的模型，否则场景无可绑模型、
   绑了文本模型会被网关静默跳过
6. 业务层调用 `runBilledScene(prisma, gateway, { sceneCode, merchantId, requestId, variables, bizId })`
7. 处理返回值：`isFallbackTemplate` 为 true 时前端提示降级、不扣积分；
   **图像场景另需判「非兜底 + 看起来像地址」** —— 兜底模板渲染出的是文字，当图片地址用会在下游报错
8. 后台验证：场景列表可见且分组 / 「类型」列正确（AI 场景页）→ 通道测试通过（AI 供应商页）
   → 调用日志有记录（AI 调用日志页）→ **同 requestId 重放不再扣费**

---

## 8. 后台管理页使用说明

路径：管理后台 → **AI 场景**（`/ai/scenes`）

- **分类筛选**：全部 / 文案创作 / 分镜脚本 / 发布素材 / 合成增强，按钮上直接显示各类数量
- **状态标记**：`已接入`（有业务调用方） / `待接入`（场景已就位，等 worker 接入）；停用场景额外显示 `停用`
- **列表列**：分类 / 场景编码 / 名称 / **类型** / 默认模型 / 备用模型 / 冻结上限 / 状态 / 操作
  - 默认模型与备用模型显示为「通道/模型名」，不再是裸 ID
  - ★ **类型**列区分「文本」与「图像（出图）」：两者走不同接口、按不同方式结算，不能混看
- **编辑弹窗**：场景编码（编辑时锁定，业务按 code 调用）、名称、**场景类型（只读）**、提示词模板、兜底模板、默认模型（单选）、备用模型（多选）、冻结上限、超时、重试次数、温度、输出上限、启用开关
  - ★ 模型下拉**按场景类型过滤候选池**：图像场景只列 `capability = 'IMAGE'` 的模型。这是刻意的 ——
    绑错不会报错，只会让网关把每个候选都当「能力不符」跳过，最后表现为「AI 繁忙，已用兜底文案」

> 保存时后端会校验：编码/名称/提示词必填、默认模型必选。
> 修改即时生效（网关每次调用都读库），**无需重启后端**。
