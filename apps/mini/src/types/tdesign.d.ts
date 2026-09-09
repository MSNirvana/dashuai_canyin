// 全局 JSX 声明：TDesign 组件通过 usingComponents 注入，
// 运行时由微信小程序原生解析；TypeScript 仅需最小占位类型以通过编译。

import 'react'

declare module 'react' {
  namespace JSX {
    interface IntrinsicAttributes {
      // TDesign 组件统一接受 name / size / color / className / style 等常见属性，
      // 真实 prop 校验由运行时小程序组件负责
      [key: `t-${string}`]: unknown
    }
  }
}

// 用一个最宽松的属性接口满足所有 t-* 标签
interface TdMiniAttr {
  name?: string
  size?: string | number
  color?: string
  className?: string
  style?: string | Record<string, unknown>
  [key: string]: unknown
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      't-button': TdMiniAttr
      't-input': TdMiniAttr
      't-cell': TdMiniAttr
      't-cell-group': TdMiniAttr
      't-toast': TdMiniAttr
      't-dialog': TdMiniAttr
      't-icon': TdMiniAttr
    }
  }
}

export {}
