/** 擦除（三步 + 校验 + 台账）。骨架。顺序不可颠倒。 */
import type { EraseOutcome, RootEraseResult } from '../shared/types.js'

export async function eraseRoot(root: string): Promise<RootEraseResult> {
  // ① 去 world 的 FILE_DELETE_CHILD 拒绝（Everyone 有名字，icacls 等价物可解）
  // ② 撤销能力 ACE + 清除低标签
  //    - 首选模块 API：AclWriteGrant.create(workspaceWriteSid(root)) → add(root,false) → dispose()
  //    - 禁止 icacls /remove:g（未映射 SID，实测 processed 0 files）
  //    - 注意 add() 的"三件不精确在位会先重写"陷阱 → 先探测，或自己走 Win32 只撤销
  // ③ 删除本次创建的 dsh-* 私有 temp 目录（先解拒绝再删）
  // ④ 上层目录深度受限扫描，回收随移动外溢的孤儿标签
  // ⑤ 校验：根上无 Low / 无 (DENY) / 无 S-1-4-；目录级全量 + 文件抽样（配额）
  throw new Error('not implemented')
}

export async function eraseAll(roots: string[]): Promise<EraseOutcome> {
  // TODO(M2): 每工作区取锁（每路径锁文件）→ 逐根擦除 → 汇总 pending → 写台账
  throw new Error('not implemented')
}
