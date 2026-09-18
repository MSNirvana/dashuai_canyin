import { Dialog } from 'tdesign-react'
import DataTable from '../lib/table'
import type { Material, RenderRow } from '../lib/render-task'

/**
 * 素材清单弹窗：剪辑师下载这条任务的口播素材与拍摄片段。
 *
 * 两个页面（「合成任务」与「精品接单」）共用一份 —— 素材清单是剪辑师真正干活的地方，
 * 两份实现漂了的话，表现为「同一个任务在一个页面上能下载、在另一个页面上是灰的」，
 * 而这类差异没有任何日志可循。
 */
export default function MaterialsDialog({
  data,
  onClose,
}: {
  /** 为 null 时关闭；row 只是用来显示任务号 */
  data: { row: RenderRow; list: Material[] } | null
  onClose: () => void
}) {
  return (
    <Dialog
      header={`素材清单 · 任务 #${data?.row.id ?? ''}`}
      visible={!!data}
      footer={false}
      onClose={onClose}
      width={680}
    >
      <DataTable
        rowKey="seq"
        size="small"
        data={data?.list ?? []}
        columns={[
          { colKey: 'seq', title: '#', width: 50 },
          { colKey: 'line', title: '口播文案', ellipsis: true, render: ({ row }: any) => row.line ?? '—' },
          {
            colKey: 'dur',
            title: '时长',
            width: 90,
            render: ({ row }: any) => {
              // 有裁剪区间就按裁剪后的算 —— 剪辑师要的是「这段给我几秒」，
              // 不是素材原始长度（两者常不同，显示错会让人以为素材不对）
              const d =
                row.trimEndMs && row.trimEndMs > row.trimStartMs ? row.trimEndMs - row.trimStartMs : row.durationMs
              return d ? `${Math.round(d / 1000)}s` : '—'
            },
          },
          {
            colKey: 'op',
            title: '下载',
            width: 90,
            render: ({ row }: any) =>
              row.playUrl ? (
                <a href={row.playUrl} target="_blank" rel="noreferrer">
                  下载
                </a>
              ) : (
                <span style={{ color: '#999' }}>演示环境</span>
              ),
          },
        ]}
      />
      <div style={{ color: '#999', fontSize: 12, marginTop: 8 }}>
        签名链接 1 小时内有效；演示环境未配置 COS，仅展示素材信息。
      </div>
    </Dialog>
  )
}
