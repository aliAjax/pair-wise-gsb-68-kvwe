export type ClaimStatus = '核查中' | '待编辑复核' | '已发布' | '已撤回'
export type FactConclusion = '已证实' | '部分属实' | '证据不足' | '不实'
export type EvidenceKind = '原始证据' | '二次来源' | '待证信息'

/** 发布批次状态：基线（旧数据升级）/ 复核中（结论已冻结）/ 已批准 / 已撤回 / 已失效 / 冲突草稿 */
export type BatchStatus = '基线' | '复核中' | '已批准' | '已撤回' | '已失效' | '冲突草稿'
/** 发布窗口动作 */
export type BatchAction = '发布' | '撤回'
/** 漂移原因：证据版本 / 结论 / 疑点 三类变化 */
export type DriftKind = '证据版本' | '结论' | '疑点'

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
  /** 被撤下的证据保留记录，不参与发布校验 */
  retracted?: boolean
  supersededBy?: string
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
  /** 发布批次修订号；旧数据没有该字段，进入系统时升级为可追溯基线 rev=0 */
  rev?: number
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
  /** 写入失败恢复产生的审计只落一次；重放同一回执时不再新增审计 */
  receiptId?: string
}

/** 冻结进批次的单条事实依据：结论、疑点、证据版本与撤下状态 */
export interface FactBasis {
  factId: string
  text: string
  conclusion: FactConclusion
  confidence: number
  unresolved: string[]
  sources: Array<{ id: string; title: string; version: number; retracted: boolean; contentHash: string; counter: boolean }>
}

/** 漂移条目：受影响事实与差异说明 */
export interface BatchDrift {
  factId: string
  kind: DriftKind
  /** 冻结依据中的值 */
  frozen: string
  /** 当前工作区中的值 */
  current: string
  sourceId?: string
}

/** 后到动作与先到结果的差异 */
export interface BatchDiff {
  factId?: string
  label: string
  expected: string
  actual: string
}

/** 后到动作留下的冲突草稿 */
export interface LateActionDraft {
  action: BatchAction
  windowId: string
  expectedRev: number
  actualRev: number
  differences: BatchDiff[]
  arrivedAt: string
  idempotencyKey?: string
}

/** 已完成动作的回执，重放同键回执不新增审计、不重复执行 */
export interface BatchReceipt {
  key: string
  batchId: string
  claimId: string
  action: BatchAction
  windowId: string
  result: '已批准' | '已撤回' | '冲突草稿'
  rev: number
  createdAt: string
  replayed?: boolean
}

/**
 * 发布批次：进入复核时冻结结论、来源和相反证据；
 * 之后复核只按这份依据审阅。未批准批次失效、已批准批次标注必须复议，
 * 均保留完整快照；写入失败时可从上一完整批次恢复。
 */
export interface PublicationBatch {
  id: string
  claimId: string
  seq: number
  status: BatchStatus
  /** 冻结时主张修订号 */
  baseRev: number
  /** 冻结依据的修订号；批准/撤回后为决策修订号 */
  batchRev: number
  windowId: string
  frozenAt: string
  decidedAt?: string
  frozenBasis: FactBasis[]
  frozenClaimStatus: ClaimStatus
  drift: BatchDrift[]
  lateDraft?: LateActionDraft
  mustReconsider?: boolean
  /** 完成时保存的完整主张快照（写入失败恢复的“上一完整批次”） */
  snapshotClaim?: Claim
  snapshotLabel: string
  snapshotComplete: boolean
  isBaseline?: boolean
}
