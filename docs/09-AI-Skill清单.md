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

## 1. 已上线 Skill（5 个）

### 1.1 文案创作组

| Skill（sceneCode） | 中文名 | 定位 | 触发入口 |
|---|---|---|---|
| `copy_traffic` | 文案 · 流量款 | 同城引流 / 话题热度：强钩子、本地梗、低门槛行动指令 | 编辑页「流量款」卡片 |
| `copy_intro` | 文案 · 介绍款 | 菜品讲解 / 套餐推广：讲清是什么、怎么吃、性价比 | 编辑页「介绍款」卡片 |
| `copy_quality` | 文案 · 质量款 | 食材品质 / 匠心人设：讲来源、工艺、老板的坚持 | 编辑页「质量款」卡片 |
| `copy_recommend` | 文案 · 种草型 | 真实体验 / 消费决策：自然分享、细节体验、收藏到店 | 编辑页「种草型」卡片 |
| `copy_generate` | 文案 · 通用版 | 兼容旧客户端；新款式的场景缺失/停用时的回退目标 | 旧客户端 / 容错回退 |

- 接口：`POST /creations/:id/copy`（入参 `track`，返回 `track` / `trackLabel`）
- 变量：`{{storeName}} {{category}} {{city}} {{dishName}} {{dishIntro}} {{sellingPoints}} {{persona}} {{copyText}} {{track}} {{trackLabel}}`
- 冻结上限：5 积分 / 次（`beanPrice`，非标价）
- 容错：款式对应场景不存在或被停用 → 自动回退 `copy_generate`，不报错

### 1.2 分镜脚本组

| Skill（sceneCode） | 中文名 | 定位 | 触发入口 |
|---|---|---|---|
| `storyboard_generate` | 分镜脚本生成 | 按复杂度产出 2~9 个分镜，标注景别/时长/台词/画面要求，并匹配镜头库手法 | 编辑页「生成分镜」 |

- 接口：`POST /creations/:id/storyboard`（入参 `complexity`）
- 变量：在文案变量基础上增加 `{{complexity}} {{complexityLabel}} {{shotCountRule}} {{shotLibrary}}`
- 复杂度规则：`SIMPLE` 2~3 镜 / `COMPLEX` 5~6 镜 / `FINE` 6~9 镜，经 `{{shotCountRule}}` 注入
- 输出：JSON 数组，字段 `seq / shotType / shotSize / durationSuggest / line / visualReq / libraryCode`
- 冻结上限：10 积分 / 次

### 1.3 模型绑定策略（seed 自动维护）

`prisma/seed.ts` 在写入场景时按以下优先级绑定模型：

1. 找**第一个「已启用的真实模型」**（`provider.enabled = true` 且 `protocol != 'MOCK'`）→ 作为所有场景的 `defaultModelId`
2. 把 `mock-chat` 作为 `fallbackModelIds`（兜底通道）
3. 若一个真实模型都没有（本地无 key 的裸环境）→ 退回 `mock-chat` + `mock-reasoner`，保证链路可跑

当前配置策略：全部 11 个场景优先绑定启用的真实模型（当前为 `gpt-5.6-sol`），`fallback = mock-chat`。

> ⚠ 踩坑记录：此前 5 个场景的默认模型全部指向已停用的 MOCK 通道，且真实可用的 `gpt-5.6-sol` 未被任何场景引用，导致每次生成都直接落到兜底模板（前端提示「AI 繁忙，已用兜底文案」）。
> 根因是 `scripts/setup-gpt5sol.ts` 只覆盖了 2 个场景，后续新增的文案三款没同步绑定。
> 现在由 seed 统一维护绑定关系，**新增场景只要进 seed 就自动拿到正确模型**。

---

## 2. 已注册 · 待接入 Skill（5 个）

来源：`docs/06-全链路梳理与三档生成方案.md` 第 3.2 节。定位是 **AI 生成（aiMode=true）合成链路的增强步骤**，每步独立成场景、独立计费、独立降级，坏一步不阻塞整链。

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

- `AiScene.beanPrice` = **单次冻结上限**（财务安全网），不是标价。
- 每个 Skill **必须配兜底模板**，保证通道全挂时流程不断。

---

## 5. 后台可配项（每个 Skill 独立）

| 配置项 | 说明 |
|---|---|
| 提示词模板 | 支持 `{{变量}}` 占位符 |
| 兜底模板 | 全通道失败时的静态输出，同样支持变量 |
| 默认模型 | 首选执行模型 |
| 备用模型链 | 默认失败后按序尝试 |
| 温度 | 0~1，越高越随机 |
| 输出上限 | `maxOutputTokens` |
| 超时 / 重试 | `timeoutMs` / `maxRetries` |
| 冻结上限 | `beanPrice` |
| 启用开关 | 停用后业务层回退或报错 |

---

## 6. 涉及文件

**服务端**
- `prisma/schema.prisma`（`AiScene` / `AiModel` / `AiProvider` / `AiCallLog`）
- `prisma/seed.ts`（5 个内置场景的提示词与兜底模板）
- `src/ai/gateway.ts`（候选链 / 熔断 / 成本核算）
- `src/ai/ai.service.ts`（`runBilledScene`：冻结 → 调用 → 结算/解冻）
- `src/ai/adapters.ts`（`OPENAI_COMPATIBLE` / `ANTHROPIC_NATIVE` / `MOCK` 协议适配）
- `src/services/creation.service.ts`（`COPY_TRACKS` / `COMPLEXITIES` / 场景解析）
- `src/services/admin-ai.service.ts`（场景 CRUD）

**后台**
- `src/pages/AiScenes.tsx`（场景列表 + 多行提示词编辑）
- `src/pages/AiProviders.tsx` / `AiModels.tsx` / `AiCallLogs.tsx` / `TtsProviders.tsx`

**小程序**
- `src/services/creation.ts`（`generateCopy` / `generateStoryboard`）
- `src/pages/creation/edit.tsx`（款式 / 复杂度卡片 + 生成按钮）

---

## 7. 新增一个 Skill 的标准步骤

1. 在 `prisma/seed.ts` 的 `seedAi()` 中 `upsert` 一条 `aiScene`（提示词 + 兜底模板 + 冻结上限；**模型绑定不用写死**，seed 会自动挂到已启用的真实模型）
2. 跑 `npm run db:seed` 生效（或直接在后台「AI 场景」页新建）
3. 业务层调用 `runBilledScene(prisma, gateway, { sceneCode, merchantId, requestId, variables, bizId })`
4. 处理返回值：`isFallbackTemplate` 为 true 时前端提示降级、不扣积分
5. 后台验证：场景列表可见（AI 场景页）→ 通道测试通过（AI 供应商页）→ 调用日志有记录（AI 调用日志页）

---

## 8. 后台管理页使用说明

路径：管理后台 → **AI 场景**（`/ai/scenes`）

- **分类筛选**：全部 / 文案创作 / 分镜脚本 / 合成增强，按钮上直接显示各类数量
- **状态标记**：`已接入`（有业务调用方） / `待接入`（场景已就位，等 worker 接入）；停用场景额外显示 `停用`
- **列表列**：分类 / 场景编码 / 名称 / 默认模型 / 备用模型 / 冻结上限 / 状态 / 操作
  - 默认模型与备用模型显示为「通道/模型名」，不再是裸 ID
- **编辑弹窗**：场景编码（编辑时锁定，业务按 code 调用）、名称、提示词模板、兜底模板、默认模型（单选）、备用模型（多选）、冻结上限、超时、重试次数、温度、输出上限、启用开关

> 保存时后端会校验：编码/名称/提示词必填、默认模型必选。
> 修改即时生效（网关每次调用都读库），**无需重启后端**。
