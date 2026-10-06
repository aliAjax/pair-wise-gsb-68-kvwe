export type ClaimStatus = '核查中' | '待编辑复核' | '已发布' | '已撤回'
export type FactConclusion = '已证实' | '部分属实' | '证据不足' | '不实'
export type EvidenceKind = '原始证据' | '二次来源' | '待证信息'

export interface SourceRecord {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt: string
  capturedAt: string
  kind: EvidenceKind
  chainOfCustody: string
  contentHash: string
  version: number
  supersededBy?: string
  /** 所属批次修订号；旧数据缺失时由基线迁移补齐 */
  revision?: number
  /** 被另一窗口撤下（不删除，保留留档） */
  withdrawn?: boolean
  withdrawnAt?: string
}

export interface ClaimAnnotation {
  id: string
  author: string
  role: '记者' | '编辑' | '事实核查员'
  content: string
  createdAt: string
  resolved: boolean
}

export interface ClaimFact {
  id: string
  text: string
  conclusion: FactConclusion
  confidence: number
  unresolved: string[]
  sources: SourceRecord[]
  counterSources: SourceRecord[]
  annotations: ClaimAnnotation[]
}

export interface Claim {
  id: string
  title: string
  summary: string
  reporter: string
  editor: string
  status: ClaimStatus
  priority: '低' | '中' | '高'
  createdAt: string
  updatedAt: string
  version: number
  /** 批次修订号（单调递增）；旧数据缺失时迁移为基线 rev1 */
  revision?: number
  facts: ClaimFact[]
}

export interface VersionRecord {
  id: string
  claimId: string
  version: number
  editor: string
  summary: string
  changedFactIds: string[]
  removedEvidence: string[]
  createdAt: string
}

export interface AuditEntry {
  id: string
  claimId: string
  action: string
  operator: string
  detail: string
  createdAt: string
  /** 触发该审计的回执号；回执重放不会再产生审计 */
  receiptId?: string
}

/* ---------------- 发布批次 ---------------- */

export type BatchStatus = '复核中' | '已失效' | '已发布' | '已撤回'
export type BatchAction = '发布' | '撤回'

export interface FrozenSource {
  id: string
  title: string
  url: string
  publisher: string
  publishedAt: string
  capturedAt: string
  kind: EvidenceKind
  chainOfCustody: string
  contentHash: string
  version: number
  withdrawn?: boolean
}

export interface FrozenFact {
  factId: string
  text: string
  conclusion: FactConclusion
  confidence: number
  unresolved: string[]
  sources: FrozenSource[]
  counterSources: FrozenSource[]
}

/** 进入复核时冻结的唯一审阅依据：结论、来源、相反证据 */
export interface ClaimBasis {
  frozenAt: string
  frozenBy: string
  claimRevision: number
  claimStatus: ClaimStatus
  facts: FrozenFact[]
}

export type ImpactKind =
  | '事实新增'
  | '事实移除'
  | '事实变化'
  | '结论变化'
  | '置信度变化'
  | '疑点变化'
  | '证据新增'
  | '证据改版'
  | '证据撤下'

export interface FactImpact {
  factId: string
  text: string
  kind: ImpactKind
  before: string
  after: string
}

export interface BatchHistoryEntry {
  revision: number
  action: BatchAction | '进入复核'
  editor: string
  note: string
  createdAt: string
  supersedes?: string
}

export interface PublishedBatch {
  id: string
  claimId: string
  status: BatchStatus
  /** 批次当前修订号：进入复核时冻结，发布/撤回成功后递增 */
  revision: number
  basis: ClaimBasis
  /** 失效或必须复议时列出的受影响事实 */
  impact: FactImpact[]
  mustReconsider: boolean
  reconsiderNote?: string
  history: BatchHistoryEntry[]
  conflictDraftIds: string[]
  createdBy: string
  createdAt: string
  approvedBy?: string
  approvedAt?: string
  withdrawnBy?: string
  withdrawnAt?: string
  invalidatedBy?: string

  invalidatedAt?: string
}

export interface ConflictDraft {
  id: string
  batchId: string
  claimId: string
  windowName: string
  action: BatchAction
  attemptedRevision: number
  currentRevision: number
  diff: string[]
  createdAt: string
  resolution: '待处理' | '已丢弃'
  receiptId?: string
}

export interface ReceiptRecord {
  id: string
  batchId: string
  claimId: string
  action: BatchAction
  attemptedRevision: number
  outcome: '已提交' | '冲突草稿' | '幂等重放'
  replayCount: number
  createdAt: string
  lastReplayAt?: string
  auditEntryId?: string
}

export interface RecoveryRecord {
  id: string
  at: string
  trigger: '启动恢复' | '写入失败'
  walId?: string
  batchId?: string
  detail: string
  restoredTo: string
}
