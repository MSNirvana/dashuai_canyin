import { useCallback, useEffect, useRef, useState } from 'react'
import { request } from './http'

export interface PageResult<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

export interface ListQuery<T> {
  data: { list: T[]; total: number } | null
  loading: boolean
  page: number
  pageSize: number
  /** 交给 DataTable 的 pagination 属性，已接好翻页与跳页 */
  pagination: {
    total: number
    pageSize: number
    current: number
    showJumper: boolean
    pageSizeOptions: number[]
    onCurrentChange: (current: number, pageInfo: { pageSize: number }) => void
    onPageSizeChange: (size: number) => void
  }
  /** 用当前页重新查询（增删改后调用） */
  reload: () => void
  /** 按指定页查询 */
  go: (page: number) => void
}

/**
 * 后台列表页统一的分页 + 竞态防护。
 *
 * 修掉两个真实问题（审读 P2-7 / P2-8）：
 *
 * 1) **分页未接线**：原先页面把 pageSize 写死、只请求第 1 页，`pagination` 传的是常量
 *    `current: 1` 且没有翻页回调 —— 分页控件长得像能用，点了没反应，第 2 页永远看不到。
 *
 * 2) **筛选切换竞态**：切换筛选条件会并发多个请求，慢的旧响应可能后到并覆盖新结果，
 *    表现为「表格内容与筛选条件对不上」。这里用**同步 ref 递增版本号**，过期响应直接丢弃。
 *    版本号必须是 ref 而不是 state：setState 是异步的，用它做闸门挡不住同一轮事件里的并发。
 *
 * 参数与 url 存进 ref，避免调用方每次渲染传入新对象字面量导致无限重查；
 * 真正触发重查的是参数的 JSON 序列化结果（paramsKey）。
 */
export function useListQuery<T>(opts: {
  url: string
  params?: Record<string, unknown>
  pageSize?: number
}): ListQuery<T> {
  const pageSizeInit = opts.pageSize ?? 20
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pageSizeInit)
  const [data, setData] = useState<{ list: T[]; total: number } | null>(null)
  const [loading, setLoading] = useState(false)

  const seqRef = useRef(0)
  const urlRef = useRef(opts.url)
  urlRef.current = opts.url
  const paramsRef = useRef(opts.params)
  paramsRef.current = opts.params
  const paramsKey = JSON.stringify(opts.params ?? {})

  const load = useCallback(
    async (targetPage: number, targetSize: number) => {
      const seq = ++seqRef.current
      setLoading(true)
      try {
        const r = await request<PageResult<T>>({
          url: urlRef.current,
          params: { ...(paramsRef.current ?? {}), page: targetPage, pageSize: targetSize },
        })
        if (seq !== seqRef.current) return // 已有更新的请求发出，本次结果已过期
        setData({ list: r?.list ?? [], total: r?.total ?? 0 })
        setPage(targetPage)
        setPageSize(targetSize)
      } catch {
        if (seq !== seqRef.current) return
        setData({ list: [], total: 0 })
      } finally {
        if (seq === seqRef.current) setLoading(false)
      }
    },
    [], // 只读 ref，无需依赖
  )

  // 筛选条件变化 → 回到第 1 页重新查询
  useEffect(() => {
    void load(1, pageSizeInit)
  }, [paramsKey, load, pageSizeInit])

  return {
    data,
    loading,
    page,
    pageSize,
    pagination: {
      total: data?.total ?? 0,
      pageSize,
      current: page,
      showJumper: true,
      pageSizeOptions: [20, 50, 100],
      onCurrentChange: (current) => {
        void load(current, pageSize)
      },
      onPageSizeChange: (size) => {
        void load(1, size)
      },
    },
    reload: () => {
      void load(page, pageSize)
    },
    go: (p: number) => {
      void load(p, pageSize)
    },
  }
}
