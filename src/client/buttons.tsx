/** 按钮行（骨架）。规格见 docs/02-ux-and-flows.md §1。 */
export const LABELS = {
  zh: { sweep: '清理沙箱痕迹', close: '关闭 DeepSeek Harness' },
  en: { sweep: 'Sweep sandbox traces', close: 'Close DeepSeek Harness' },
} as const

/** 布局：一行两枚，各占新会话按钮宽度的一半 */
export const ROW_STYLE = {
  display: 'flex',
  gap: 8,
  width: '100%',
} as const

export const BUTTON_STYLE = {
  flex: '1 1 0',
  // 颜色取自主题 danger 语义变量（禁止硬编码），需在浅色/深色两套主题下校验对比度
  borderColor: 'var(--dsh-color-danger, currentColor)',
  color: 'var(--dsh-color-danger, currentColor)',
} as const

export function ButtonRow(): never {
  // TODO(M4): 复用 @deepseek-ai/dsh-client-ui-primitives 的按钮原语与 token
  // TODO(M4): 点击 → 自检对话框（docs/02-ux-and-flows.md §3.3 / §4.1）
  throw new Error('not implemented')
}
