// TDesign DialogPlugin.confirm 的 Promise 封装（原生返回 DialogInstance，不是 Promise）
import { DialogPlugin } from 'tdesign-react'

export function confirmDialog(header: string, body: string): Promise<boolean> {
  return new Promise((resolve) => {
    const dialog = DialogPlugin.confirm({
      header,
      body,
      confirmBtn: '确认',
      cancelBtn: '取消',
      onConfirm: () => {
        dialog.hide()
        dialog.destroy()
        resolve(true)
      },
      onClose: () => {
        dialog.destroy()
        resolve(false)
      },
      onCancel: () => {
        dialog.destroy()
        resolve(false)
      },
    })
  })
}
