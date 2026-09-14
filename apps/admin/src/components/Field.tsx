import type { CSSProperties, ReactNode } from 'react'

/**
 * 表单行 / 表单组（替代 tdesign 的 <Form> + <Form.FormItem>）
 *
 * ── 为什么不用 tdesign 的 FormItem？ ────────────────────────────────────────
 * tdesign-react 1.9.x 的 FormItem 会对子节点做 cloneElement，并**无条件**注入
 * `value={formValue}`（见 node_modules/tdesign-react/es/form/FormItem.js 的
 * `React.cloneElement(child, { ...child.props, [ctrlKey]: formValue, onChange })`）。
 *
 * 而 formValue 只在挂载时由 `getDefaultInitialData()` 求值一次，该函数在
 * 「FormItem 没有 name」时的兜底分支是：
 *     return isMultiple ? [] : initialDataMap.get(lastChild.type)
 * 其中 initialDataMap 只登记了 Tree / Upload / Transfer / TagInput / RangeInput /
 * CheckboxGroup / DateRangePicker / TimeRangePicker / Checkbox 九类组件，
 * Input / Textarea / Select / InputNumber / Switch **一律返回 undefined**。
 *
 * 结果：子组件自己传的受控 value 被 undefined 覆盖 → 弹窗里所有输入框显示为空。
 * 本后台的表单统一用 React state 自管受控值，并不需要 tdesign 的字段注册能力，
 * 所以这里自绘 label + 控件布局，行为完全可预期。
 * ──────────────────────────────────────────────────────────────────────────
 */

export type FieldStatus = 'error' | 'success' | 'warning'

interface FieldProps {
  label: ReactNode
  children: ReactNode
  /** 单独覆盖标签宽度（px）；不传则继承 FieldGroup 的 --field-label-width */
  labelWidth?: number
  /** 仅展示必填星号 */
  required?: boolean
  /** 校验状态，用于给控件加边框色 */
  status?: FieldStatus
  /** 控件下方的辅助说明 */
  help?: ReactNode
}

/** 表单组：统一控制内部所有 Field 的标签宽度 */
export function FieldGroup({
  labelWidth = 120,
  children,
}: {
  labelWidth?: number
  children: ReactNode
}) {
  return (
    <div
      className="form-group"
      style={{ '--field-label-width': `${labelWidth}px` } as CSSProperties}
    >
      {children}
    </div>
  )
}

export default function Field({
  label,
  children,
  labelWidth,
  required,
  status,
  help,
}: FieldProps) {
  return (
    <div className={`form-row${status ? ` form-row--${status}` : ''}`}>
      <div
        className="form-row__label"
        style={labelWidth ? { flex: `0 0 ${labelWidth}px`, width: labelWidth } : undefined}
      >
        {required ? <span className="form-row__required">*</span> : null}
        {label}
      </div>
      <div className="form-row__control">
        {children}
        {help ? <div className="form-row__help">{help}</div> : null}
      </div>
    </div>
  )
}
