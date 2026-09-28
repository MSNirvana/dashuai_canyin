// 红色细进度条：用于 AI 生成 / 视频上传 / 成片合成
// 统一「进度条 + 百分比 + 文案」，禁止无反馈的转圈
//
// 用法：<ProgressLine percent={62} label='成片合成中' hint='预计还需 2 分钟' />
//
// ⚠ 布局：**进度条在上，文案、补充说明与百分数在条下方同一行**（顺序：文案 → 补充说明 → 百分数）。
// 早先是「文案 + 百分数」单独占条上方一行，等于一条进度吃两行高度；
// 创作列表一屏要放多条项目，那一行就是被它吃掉的。
// ★ 2026-09-28：hint（补充说明）也收进这同一行了。它原来独占条下方一行，
//   而它多数时候只是半句话（如「请保持页面打开」）⇒ 一行短说明把卡片撑出第三行，
//   读起来像另起一段。现在它跟在文案右侧、靠 `&__spacer` 把百分数顶到最右。
//   ⚠★ 传 hint 的调用点**不止合成页**，改这个组件前必须按下面这份清单核一遍
//     （我第一版注释写成「只有合成页」，是错的；且清单本身也会随需求过期 —— **每次都要重数**）：
//       · `pages/render/compose.tsx:1418`  传（合成中 / 预计交付 …）—— 同行有 label + 百分数
//       · `pages/creation/shots.tsx:433`   传 —— ★★ **纯 hint**（无 label、showValue=false），
//                                            且文案最长 24 字。它原来靠 block 换行，现在被收成单行，
//                                            所以必须单独确认「不截断」
//                                            （8 条逐条量过：最宽 233.27 / 可用 325.63 ⇒ 余量 28.4%）
//       · `pages/render/compose.tsx:1563`  不传（2026-09-28 按用户要求删掉了它的那句 hint）
//       · `pages/creation/shots.tsx:482`   不传
//       · `pages/creation/list.tsx:404`    不传
//     ★ 结论：共 5 个调用点、**2 个传 hint**；对「不传」的 3 处是恒等变换。

import { View, Text } from '@tarojs/components'
import './index.scss'

interface Props {
  /** 0 - 100 */
  percent: number
  /** 左侧说明文案 */
  label?: string
  /** 紧随文案右侧的补充说明（如「处理中，请保持页面打开」/「预计交付 18:30」），字号与文案同档但颜色更浅 */
  hint?: string
  /** 是否显示百分比数字（默认 true） */
  showValue?: boolean
  className?: string
}

export default function ProgressLine({ percent, label, hint, showValue = true, className = '' }: Props) {
  const pct = Math.max(0, Math.min(100, Math.round(percent)))
  return (
    <View className={`pline ${className}`}>
      <View className='pline__track'>
        <View className='pline__fill' style={{ width: `${pct}%` }} />
      </View>
      {/* ★ 条件里必须带上 `!!hint`：hint 已经挪进这一行（见下）。
          漏了它，「传了 hint、但 label 与 showValue 都没给」时整行不渲染，
          那句提示会**静默消失** —— 而「少了一句灰字」这种回归，看代码是看不出来的。 */}
      {(!!label || !!hint || showValue) && (
        <View className='pline__foot'>
          {!!label && <Text className='pline__label'>{label}</Text>}
          {/* ★ 2026-09-28：hint 从「进度条下方单独一行」挪到这里，紧跟在 label 右侧。
              原来它独占一行 —— 一句短说明就把卡片撑出第三行，读起来像另起了一段话
              （用户看到的就是「合成中 …… 82%」下面再挂一行灰字）。
              挪进来之后，`&__spacer` 照旧把百分数顶到最右，整块仍是「状态 … 百分数」一行。
              ⚠ 挪进 flex 行后 hint 会**参与收缩**（原先是 block 独占整行、不会被挤），
                所以 `&__hint` 补了 `min-width: 0` + 省略号：空间不足时截断，百分数**不会被顶出去**
                （实测注入 37 字：截断生效、百分数仍贴右、无溢出）。
                ⚠ 但被压的不只是 hint —— label 同为可收缩项，**也会一起被压**（34.3 → 21.8）。
                  当前两种文案都留有很大余量（125.8 / 140.5，可用 325.6）⇒ 走不到；
                  要防的话见 `&__hint` 的注释（加 `flex: none` 的修饰类），别在这里瞎猜。 */}
          {!!hint && <Text className='pline__hint'>{hint}</Text>}
          <View className='pline__spacer' />
          {showValue && <Text className='pline__value'>{pct}%</Text>}
        </View>
      )}
    </View>
  )
}
