/**
 * 宿主半入口（骨架）。
 * 运行在 DSH 宿主进程内 —— 不受文件沙箱限制，因此是唯一能写 ACL 的一侧。
 */
import type { PreflightReport, EraseOutcome, RevokeResult } from '../shared/types.js'

export interface HostApi {
  /** 只读自检：会话 / 终端 / 作业 / 其他实例 / 工作区 / 三件现状 */
  probe(): Promise<PreflightReport>
  /** 仅擦除（供"清理沙箱痕迹"按钮在门禁通过后调用） */
  sweepOnly(opts: { force: boolean }): Promise<EraseOutcome>
  /** 关闭本实例：FENCE → QUIESCE → FLUSH → [ERASE] → DISPOSE → EXIT */
  closeInstance(opts: { erase: boolean; force: boolean }): Promise<void>
  /** 权限回收：把通过检查的会话切到 read-only */
  revokeToReadOnly(): Promise<RevokeResult[]>
}

// TODO(M1): 注册宿主 RPC 与路由（Spike S3）
// TODO(M1): 启动清扫 —— 读取台账中的 pending 项并重跑 erase + verify
export function apply(): void {
  throw new Error('not implemented — 见 PLAN.md 里程碑 M1')
}
