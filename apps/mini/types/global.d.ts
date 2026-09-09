/// <reference types="@tarojs/taro" />

declare module '*.scss'
declare module '*.sass'
declare module '*.css'
declare module '*.png'
declare module '*.jpg'
declare module '*.jpeg'
declare module '*.svg'

// TDesign 组件在 app.config.ts 中全局注册，此处补充 TS 声明
declare namespace JSX {
  interface IntrinsicElements {
    't-button': Record<string, unknown>
    't-input': Record<string, unknown>
    't-cell': Record<string, unknown>
    't-cell-group': Record<string, unknown>
    't-toast': Record<string, unknown>
    't-dialog': Record<string, unknown>
  }
}
