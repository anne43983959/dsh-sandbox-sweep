/** 侦察（只读）。骨架。 */
import type { PreflightReport, Blocker } from '../shared/types.js'

export async function probe(): Promise<PreflightReport> {
  // TODO(M1): ctx.agents 活跃注册表 → sessions（回合/子智能体/作业/定时提醒/终端/模式）
  // TODO(M1): ctx.terminals → 常驻终端计数
  // TODO(M1): sandbox-policy 的会话工作区 → 去重得到 workspaces
  // TODO(M1): 读 ACL 判定三件现状（宿主侧，无需提权）
  // TODO(Spike S7): 进程扫描 → otherInstances（版本从命令行路径解析）
  // TODO: 汇总成 blockers（F 类 / X 类）
  throw new Error('not implemented')
}

/** 门禁判定：决定能否进入权限回收 / 擦除。 */
export function gate(blockers: Blocker[], force: boolean): { allowed: boolean; reason?: string } {
  const x = blockers.filter(b => b.kind === 'X')
  if (x.length > 0) return { allowed: false, reason: 'X 类阻塞不可强制消除：' + x.map(b => b.code).join(', ') }
  const f = blockers.filter(b => b.kind === 'F')
  if (f.length > 0 && !force) return { allowed: false, reason: '存在活跃工作，需用户显式授权强制终止' }
  return { allowed: true }
}
