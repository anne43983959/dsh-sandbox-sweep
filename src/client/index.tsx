/**
 * 客户端半入口（骨架）。
 * 注册一行两枚按钮到「新会话按钮上方」。
 * 座位与 kind 待 Spike S1 定稿；当前按"注册进 sidebar.workspaces 并排在最前"的假设书写。
 */
import { ButtonRow } from './buttons.js'

/** 座位假设：sidebar.workspaces（详见 docs/02-ux-and-flows.md §1） */
export const SLOT_KEY = 'sidebar.workspaces'

export function apply(ctx: any): void {
  // TODO(M4): ctx.locale.register('sandbox-sweep', { zh, en })
  // TODO(M4): ctx.slots.register({ key: SLOT_KEY, priority: -1, order: -1, component: ButtonRow })
  //   排序语义：list 型槽位按 priority → order 升序（见 docs/01-facts.md §7）
  //   若 S1 判定为 single 型 → 改用备选座位或向上游申请新座位
  void ctx
  void ButtonRow
  throw new Error('not implemented')
}
