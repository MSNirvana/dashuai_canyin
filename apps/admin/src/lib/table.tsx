import { Table as TdTable } from 'tdesign-react'
import type { PrimaryTableCol, PrimaryTableProps, TableRowData } from 'tdesign-react'

/**
 * ── 为什么需要这个封装 ────────────────────────────────────────────────────
 * tdesign 的表头文案本身是靠调用列的 `render` 生成的。见
 * node_modules/tdesign-react/es/table/hooks/useTableHeader.js → renderTitle()：
 *
 *     if (isFunction(col.title)) return col.title(params)
 *     if (isFunction(col.render)) return col.render({ col, colIndex, row: {}, rowIndex: -1, type: 'title' })
 *     return col.title
 *
 * 于是「列定义了 render、但 title 只是字符串」时会踩两个坑，且此时 row 是空对象 `{}`：
 *   1) **表头文案被 render 的返回值顶替**：「Base URL」列头会变成 <code>undefined</code>，
 *      「启用」列头会变成 <Tag>否</Tag>；
 *   2) **整页崩溃**：render 里只要解引用嵌套字段（`row.memberships[0]`、`row.provider.code`、
 *      `row._count.stores`），就会抛 `Cannot read properties of undefined`，
 *      被 ErrorBoundary 兜住后整页白屏。
 *
 * ── 方案 ────────────────────────────────────────────────────────────────
 * 把每个列的 `title` 包装成函数，让 renderTitle 命中第一个分支，从而把 render
 * 从表头渲染中彻底摘出去。这与 tdesign 自身在 PrimaryTable.js 里为 sorter / filter
 * 列改写 `item.title` 的做法一致。
 * ────────────────────────────────────────────────────────────────────────
 */
export function cols(list: PrimaryTableCol[]): PrimaryTableCol[] {
  return list.map((c) => ({
    ...c,
    title: (typeof c.title === 'function' ? c.title : () => c.title) as PrimaryTableCol['title'],
  }))
}

/**
 * 后台统一表格：在 tdesign Table 之上自动对 columns 做表头加固。
 * 业务页面直接 `<DataTable columns={[...]} data={[...]} />` 即可，无需关心上述坑。
 */
export default function DataTable<T extends TableRowData = TableRowData>(
  props: PrimaryTableProps<T>,
) {
  const { columns, ...rest } = props
  return (
    <TdTable<T>
      {...rest}
      columns={
        Array.isArray(columns)
          ? (cols(columns as unknown as PrimaryTableCol[]) as unknown as PrimaryTableCol<T>[])
          : columns
      }
    />
  )
}
