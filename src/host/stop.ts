/** 关闭时序。骨架。 */
import type { RevokeResult } from '../shared/types.js'

export interface StopFlow {
  fence(): Promise<void>            // 置"不再受理新的受限启动"
  quiesce(): Promise<void>          // cancel agents → 关终端 → 取消作业 → 等子进程（超时强杀并记录）
  flush(): Promise<void>            // 逐会话 ctx.sessions.flush(session)
  revokeToReadOnly(): Promise<RevokeResult[]>
  erase(): Promise<void>            // 可选
  disposeHost(): Promise<void>      // 走宿主自身 dispose 链（否则 sandbox-local 的 temp 撤销被跳过）
  exit(): Promise<never>            // 最后才退出
}

// TODO(M3): 严格按 FENCE → QUIESCE → FLUSH → [ERASE] → DISPOSE → EXIT 实现
// 禁止在 disposeHost() 之前调用 process.exit()
export function create(): StopFlow {
  throw new Error('not implemented')
}
