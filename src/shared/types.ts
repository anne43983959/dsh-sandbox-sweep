/**
 * 宿主半与客户端半共用的类型。骨架阶段只固化契约，不含实现。
 * 字段含义见 docs/02-ux-and-flows.md §3.2。
 */

export type BlockerKind = 'F' | 'X' // F = 可强制消除；X = 不可强制消除

export interface Blocker {
  kind: BlockerKind
  code: string
  detail: string
  remedy: string
}

export interface SessionActivity {
  id: string
  title: string
  turn: 'running' | 'idle' | 'waiting-user'
  subagents: number
  jobs: number
  schedules: number
  terminals: number
  sandboxMode: 'read-only' | 'workspace-write' | 'danger-full-access'
}

export interface WorkspaceState {
  root: string
  objectCountEstimate: number
  trio: { ace: boolean; deny: boolean; lowLabel: boolean }
  ownedByMe: boolean
  readable: boolean
  /** ≈ objectCountEstimate × 0.16ms（实测系数，见 docs/01-facts.md §3） */
  eraseEstimateMs: number
}

export interface InstanceInfo {
  pid: number
  version: string | null
  home: string | null
  port: number | null
  workspaces: string[]
  sharesWorkspace: boolean
  /** version >= 0.1.7-alpha.1 */
  hasTrioRisk: boolean
  source: 'process-scan' | 'lease' | 'launcher-config'
}

export interface PreflightReport {
  host: { version: string; home: string; platform: string; canWriteAcl: boolean }
  sessions: SessionActivity[]
  workspaces: WorkspaceState[]
  otherInstances: InstanceInfo[]
  blockers: Blocker[]
}

export interface RootEraseResult {
  root: string
  steps: Array<{ name: string; ok: boolean; ms: number; error?: string }>
  verified: boolean
  residue: string[]
}

export interface EraseOutcome {
  startedAt: string
  results: RootEraseResult[]
  pending: string[]
}

export interface RevokeResult {
  sessionId: string
  status: 'ok' | 'rejected-by-terminal' | 'rejected-other'
  error?: string
}

/** 客户端 → 宿主 的方法名（Spike S3 定稿注册方式） */
export type HostMethod = 'probe' | 'sweepOnly' | 'closeInstance'
