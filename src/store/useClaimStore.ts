import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { seedAudit, seedClaims, seedVersions } from '../data/seed'
import { diffBasis, freezeBasis, preflightBasis, revisionConflictDiff } from '../services/batchEngine'
import type {
  AuditEntry, Claim, ClaimAnnotation, ClaimFact, ConflictDraft, PublishedBatch,
  ReceiptRecord, RecoveryRecord, SourceRecord, VersionRecord
} from '../types'

interface SubmitResult {
  ok: boolean
  message: string
  receiptId?: string
  draftId?: string
  blocking?: string[]
}

interface WalEntry {
  id: string
  at: string
  phase: 'pre-write'
  batchId: string
  claimId: string
  action: '发布' | '撤回'
  newRevision: number
  snapshot: { batches: PublishedBatch[]; claim: Claim }
}

interface ClaimState {
  claims: Claim[]
  versions: VersionRecord[]
  audit: AuditEntry[]
  batches: PublishedBatch[]
  drafts: ConflictDraft[]
  receipts: ReceiptRecord[]
  recoveries: RecoveryRecord[]
  keyword: string
  status: Claim['status'] | '全部'
  /** 模拟下一次批次提交写入失败（不持久化，仅内存） */
  failNextWrite: boolean
  setKeyword: (value: string) => void
  setStatus: (value: Claim['status'] | '全部') => void
  addClaim: (input: { title: string; summary: string; reporter: string; priority: Claim['priority'] }) => Claim
  updateFact: (claimId: string, factId: string, patch: Partial<ClaimFact>) => void
  addFact: (claimId: string, text: string) => void
  addAnnotation: (claimId: string, factId: string, annotation: Omit<ClaimAnnotation, 'id' | 'createdAt' | 'resolved'>) => void
  resolveAnnotation: (claimId: string, factId: string, annotationId: string) => void
  addSource: (claimId: string, factId: string, source: Omit<SourceRecord, 'id' | 'capturedAt' | 'version' | 'revision' | 'withdrawn'>, counter: boolean) => void
  withdrawSource: (claimId: string, factId: string, sourceId: string, counter: boolean, reason: string) => void
  /** 从当前工作区移除（不物理删除历史：已冻结批次快照中仍保留） */
  removeSource: (claimId: string, factId: string, sourceId: string, counter: boolean, reason: string) => void
  enterReview: (claimId: string, note: string, operator?: string) => { ok: boolean; message: string; batchId?: string }
  submitBatch: (batchId: string, action: '发布' | '撤回', attemptedRevision: number, windowName: string, note: string, receiptId?: string) => SubmitResult
  resubmitDraft: (draftId: string, note: string) => SubmitResult
  discardDraft: (draftId: string) => void
  replayReceipt: (receiptId: string) => SubmitResult
  setFailNextWrite: (value: boolean) => void
  reset: () => void
}

let idSeed = 100
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`
const now = () => new Date().toISOString()
const auditOf = (claimId: string, action: string, operator: string, detail: string, receiptId?: string): AuditEntry =>
  ({ id: nextId('AUD'), claimId, action, operator, detail, createdAt: now(), receiptId })

const WAL_KEY = 'gsb68:batch-wal'

const readWal = (): WalEntry | null => {
  try {
    const raw = localStorage.getItem(WAL_KEY)
    return raw ? JSON.parse(raw) as WalEntry : null
  } catch {
    return null
  }
}
const writeWal = (entry: WalEntry | null) => {
  if (entry) localStorage.setItem(WAL_KEY, JSON.stringify(entry))
  else localStorage.removeItem(WAL_KEY)
}

export const useClaimStore = create<ClaimState>()(persist((set, get) => {
  /** 内容变化后：未批准批次失效并列出受影响事实；已批准批次保留快照但标注必须复议 */
  const reevaluateBatches = (state: ClaimState, claimId: string, changedBy: string, changeNote: string): ClaimState => {
    const claim = state.claims.find((item) => item.id === claimId)
    if (!claim) return state
    claim.revision = (claim.revision ?? 1) + 1
    claim.updatedAt = now()
    const batches = state.batches.map((batch) => {
      if (batch.claimId !== claimId) return batch
      const impact = diffBasis(batch.basis, claim)
      if (impact.length === 0) return batch
      if (batch.status === '复核中') {
        return { ...batch, status: '已失效' as const, impact, invalidatedBy: changedBy, invalidatedAt: now() }
      }
      // 已发布/已撤回：快照保留，只追加“必须复议”标注
      const note = `${changedBy}：${changeNote}；${impact.length} 项依据已偏离发布快照`
      return { ...batch, impact, mustReconsider: true, reconsiderNote: batch.reconsiderNote ? `${note}｜${batch.reconsiderNote}` : note }
    })
    return { ...state, batches, claims: [...state.claims] }
  }

  const bump = (state: ClaimState, claimId: string, changedBy: string, changeNote: string, entries: AuditEntry[], claimVersionDelta = 1): ClaimState => {
    const next = reevaluateBatches(state, claimId, changedBy, changeNote)
    const claim = next.claims.find((item) => item.id === claimId)
    if (claim) claim.version += claimVersionDelta
    return { ...next, versions: next.versions, audit: [...entries, ...next.audit] }
  }

  /**
   * 启动引导在 store 工厂外通过 bootstrapWorkbench() 执行：
   * 先按 WAL 从上一完整批次恢复，再把无修订号旧数据迁移为可追溯基线。
   */
  return {
    claims: seedClaims,
    versions: seedVersions,
    audit: seedAudit,
    batches: [],
    drafts: [],
    receipts: [],
    recoveries: [],
    keyword: '',
    status: '全部',
    failNextWrite: false,
    setKeyword: (keyword) => set({ keyword }),
    setStatus: (status) => set({ status }),

    addClaim: (input) => {
      const created = now()
      const claim: Claim = { id: nextId('FC'), ...input, editor: '宋卓', status: '核查中', createdAt: created, updatedAt: created, version: 1, revision: 1, facts: [] }
      set((state) => ({ claims: [claim, ...state.claims], audit: [auditOf(claim.id, '建立核查主张', input.reporter, input.summary), ...state.audit] }))
      return claim
    },

    addFact: (claimId, text) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      if (!claim || !text.trim()) return state
      claim.facts.push({ id: nextId('F'), text, conclusion: '证据不足', confidence: 30, unresolved: ['尚未关联来源'], sources: [], counterSources: [], annotations: [] })
      return bump(state, claimId, claim.reporter, `新增事实：${text}`, [auditOf(claimId, '拆分可验证事实', claim.reporter, text)])
    }),

    updateFact: (claimId, factId, patch) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return state
      if (patch.conclusion && patch.conclusion !== '证据不足' && fact.unresolved.length) {
        patch.confidence = Math.min(patch.confidence ?? fact.confidence, 75)
      }
      const before = `${fact.conclusion}/${fact.confidence}%`
      Object.assign(fact, patch)
      return bump(state, claimId, '当前用户', `事实 ${factId} 由 ${before} 改为 ${fact.conclusion}/${fact.confidence}%`, [auditOf(claimId, '更新事实结论', '当前用户', `${fact.text}：${fact.conclusion}`)])
    }),

    addAnnotation: (claimId, factId, input) => set((state) => {
      // 批注不改变审阅依据（结论/来源/相反证据），不推进修订号
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return state
      fact.annotations.unshift({ ...input, id: nextId('N'), createdAt: now(), resolved: false })
      claim.updatedAt = now()
      return { claims: [...state.claims], audit: [auditOf(claimId, '添加批注', input.author, input.content), ...state.audit] }
    }),

    resolveAnnotation: (claimId, factId, annotationId) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const annotation = claim?.facts.find((item) => item.id === factId)?.annotations.find((item) => item.id === annotationId)
      if (!claim || !annotation) return state
      annotation.resolved = true
      return { claims: [...state.claims], audit: [auditOf(claimId, '解决批注', '当前用户', annotation.content), ...state.audit] }
    }),

    addSource: (claimId, factId, input, counter) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return state
      const list = counter ? fact.counterSources : fact.sources
      const source: SourceRecord = { ...input, id: nextId(counter ? 'C' : 'S'), capturedAt: now(), version: 1, revision: claim.revision ?? 1 }
      list.unshift(source)
      return bump(state, claimId, '当前用户', `${counter ? '相反证据' : '支持证据'}新增：${input.title}`, [auditOf(claimId, counter ? '保留相反证据' : '关联来源', '当前用户', input.title)])
    }),

    withdrawSource: (claimId, factId, sourceId, counter, reason) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      const source = fact ? (counter ? fact.counterSources : fact.sources).find((item) => item.id === sourceId) : undefined
      if (!claim || !fact || !source) return state
      source.withdrawn = true
      source.withdrawnAt = now()
      return bump(state, claimId, '另一窗口', `证据被撤下：${source.title}（${reason}）`, [auditOf(claimId, '证据撤下留档', '另一窗口', `${source.title}：${reason}（证据不删除）`)])
    }),

    removeSource: (claimId, factId, sourceId, counter, reason) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return state
      const list = counter ? fact.counterSources : fact.sources
      const index = list.findIndex((item) => item.id === sourceId)
      if (index < 0) return state
      const [removed] = list.splice(index, 1)
      return bump(state, claimId, '当前用户', `从工作区移除证据：${removed.title}（${reason}）`, [auditOf(claimId, '移除证据留痕', '当前用户', `${removed.title}：${reason}（历史批次快照仍保留）`)])
    }),

    /** 进入复核：冻结结论、来源和相反证据，之后只按这份依据审阅 */
    enterReview: (claimId, note, operator = '宋卓') => {
      const claim = get().claims.find((item) => item.id === claimId)
      if (!claim) return { ok: false, message: '主张不存在' }
      if (claim.facts.length === 0) return { ok: false, message: '至少需要一项可验证事实才能进入复核' }
      const active = get().batches.find((batch) => batch.claimId === claimId && batch.status === '复核中')
      if (active) return { ok: false, message: `该主张已有复核中批次 ${active.id}（r${active.revision}），请在其失效或处理后再提交` }
      claim.status = '待编辑复核'
      claim.version += 1
      claim.updatedAt = now()
      const basis = freezeBasis(claim, operator)
      const batchId = nextId('B')
      const batch: PublishedBatch = {
        id: batchId, claimId, status: '复核中', revision: claim.revision ?? 1, basis, impact: [],
        mustReconsider: false, history: [{ revision: claim.revision ?? 1, action: '进入复核', editor: operator, note: note || '冻结结论、来源与相反证据，提交复核', createdAt: now() }],
        conflictDraftIds: [], createdBy: operator, createdAt: now()
      }
      set((state) => ({
        batches: [batch, ...state.batches],
        claims: [...state.claims],
        versions: [{ id: nextId('V'), claimId, version: claim.version, editor: operator, summary: `进入复核批次 ${batchId}，冻结依据 r${batch.revision}`, changedFactIds: [], removedEvidence: [], createdAt: now() }, ...state.versions],
        audit: [auditOf(claimId, '进入复核冻结依据', operator, `批次 ${batchId} 冻结 ${basis.facts.length} 项事实、${basis.facts.reduce((sum, fact) => sum + fact.sources.length + fact.counterSources.length, 0)} 条证据，修订号 r${batch.revision}`), ...state.audit]
      }))
      return { ok: true, message: `已冻结依据并进入复核（批次 r${batch.revision}）`, batchId }
    },

    /** 两窗口并发提交：后到动作按批次修订号判断；冲突留下草稿和差异，不覆盖先到结果 */
    submitBatch: (batchId, action, attemptedRevision, windowName, note, receiptIdArg) => {
      const state = get()

      // 回执重放：不新增审计，返回原始结果
      const receiptId = receiptIdArg || nextId('RCP')
      const existing = state.receipts.find((item) => item.id === receiptIdArg)
      if (existing) {
        const replayed = state.receipts.map((item) => item.id === existing.id ? { ...item, replayCount: item.replayCount + 1, lastReplayAt: now() } : item)
        set({ receipts: replayed })
        const message = existing.outcome === '已提交'
          ? `回执 ${existing.id} 重放：原「${existing.action}」结果保持，未新增审计（第 ${existing.replayCount + 1} 次重放）`
          : `回执 ${existing.id} 重放：原冲突草稿保持，未新增审计（第 ${existing.replayCount + 1} 次重放）`
        return { ok: false, message, receiptId: existing.id, draftId: existing.outcome === '冲突草稿' ? state.drafts.find((draft) => draft.receiptId === existing.id)?.id : undefined }
      }

      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch) return { ok: false, message: '批次不存在' }
      const targetClaim = state.claims.find((item) => item.id === batch.claimId)
      if (!targetClaim) return { ok: false, message: '主张不存在' }

      const saveConflict = (diff: string[]): SubmitResult => {
        const draft: ConflictDraft = {
          id: nextId('D'), batchId, claimId: batch.claimId, windowName, action,
          attemptedRevision, currentRevision: batch.revision, diff, createdAt: now(), resolution: '待处理', receiptId
        }
        const receipt: ReceiptRecord = { id: receiptId, batchId, claimId: batch.claimId, action, attemptedRevision, outcome: '冲突草稿', replayCount: 0, createdAt: now() }
        set((current) => ({
          drafts: [draft, ...current.drafts],
          receipts: [receipt, ...current.receipts],
          batches: current.batches.map((item) => item.id === batchId ? { ...item, conflictDraftIds: [draft.id, ...item.conflictDraftIds] } : item),
          audit: [auditOf(batch.claimId, '并发冲突存草稿', windowName, `${windowName} 持 r${attemptedRevision} 提交「${action}」落后于 r${batch.revision}，差异 ${diff.length} 项，先到结果未覆盖`), ...current.audit]
        }))
        return { ok: false, message: `修订号冲突：本窗口 r${attemptedRevision} 落后于 r${batch.revision}，已存草稿 ${draft.id}`, receiptId, draftId: draft.id }
      }

      // 已失效批次不能直接提交
      if (batch.status === '已失效') {
        return saveConflict(revisionConflictDiff(batch, batch.revision, action, null, null).concat([`批次已于 ${batch.invalidatedAt?.replace('T', ' ').slice(0, 16)} 失效，受影响事实 ${batch.impact.length} 项，需重新进入复核`]))
      }

      // 后到动作按批次修订号判断
      if (attemptedRevision !== batch.revision) {
        const expectedStatus = action === '发布' ? '待编辑复核' : '已发布'
        return saveConflict(revisionConflictDiff(batch, batch.revision, action, expectedStatus, targetClaim.status))
      }

      if (action === '发布') {
        // 只按冻结依据审阅
        const blocking = preflightBasis(batch.basis)
        if (blocking.length) return { ok: false, message: '冻结依据未通过发布前校验', blocking }
        if (batch.mustReconsider) return { ok: false, message: '发布快照已标注必须复议，请先重新冻结依据', blocking: [batch.reconsiderNote ?? '依据已变化'] }
        return commitBatch(state, batch, action, windowName, note, receiptId)
      }

      // 撤回：仅已发布批次可撤回
      if (batch.status !== '已发布') {
        return saveConflict([`本窗口依据 r${attemptedRevision} 提交「撤回」，但批次状态为「${batch.status}」，撤回被存为草稿`])
      }
      return commitBatch(state, batch, action, windowName, note, receiptId)
    },

    resubmitDraft: (draftId, note) => {
      const state = get()
      const draft = state.drafts.find((item) => item.id === draftId)
      if (!draft || draft.resolution === '已丢弃') return { ok: false, message: '草稿不可用' }
      // 以批次当前修订号重新提交；先到结果若已推进则再次产生新草稿
      const result = get().submitBatch(draft.batchId, draft.action, draft.currentRevision, draft.windowName, note || `由草稿 ${draftId} 重新提交`)
      if (result.ok || result.draftId !== draftId) {
        set((current) => ({ drafts: current.drafts.map((item) => item.id === draftId ? { ...item, resolution: '已丢弃' as const } : item) }))
      }
      return result
    },

    discardDraft: (draftId) => set((state) => ({
      drafts: state.drafts.map((item) => item.id === draftId ? { ...item, resolution: '已丢弃' as const } : item),
      audit: [auditOf(state.drafts.find((item) => item.id === draftId)?.claimId ?? '-', '丢弃冲突草稿', '编辑', `草稿 ${draftId} 已丢弃，差异留档`), ...state.audit]
    })),

    replayReceipt: (receiptId) => {
      const existing = get().receipts.find((item) => item.id === receiptId)
      if (!existing) return { ok: false, message: '回执不存在' }
      return get().submitBatch(existing.batchId, existing.action, existing.attemptedRevision, '', '', receiptId)
    },

    setFailNextWrite: (failNextWrite) => set({ failNextWrite }),

    reset: () => {
      writeWal(null)
      set({
        claims: structuredClone(seedClaims), versions: structuredClone(seedVersions), audit: structuredClone(seedAudit),
        batches: [], drafts: [], receipts: [], recoveries: [], keyword: '', status: '全部', failNextWrite: false
      })
    }
  }

  /** 提交落库：pre-write 日志 + 模拟写入失败 + 成功提交；失败后从上一完整批次恢复 */
  function commitBatch(state: ClaimState, batch: PublishedBatch, action: '发布' | '撤回', windowName: string, note: string, receiptId: string): SubmitResult {
    const claim = state.claims.find((item) => item.id === batch.claimId)!
    const newRevision = batch.revision + 1
    const timestamp = now()

    if (state.failNextWrite) {
      // 写入失败：记录 WAL（模拟进程在此崩溃），随后从上一完整批次恢复
      const wal: WalEntry = {
        id: nextId('WAL'), at: timestamp, phase: 'pre-write', batchId: batch.id, claimId: claim.id, action, newRevision,
        snapshot: { batches: state.batches, claim: structuredClone(claim) }
      }
      writeWal(wal)
      const recovery: RecoveryRecord = {
        id: nextId('REC'), at: timestamp, trigger: '写入失败', walId: wal.id, batchId: batch.id,
        detail: `「${action}」写入失败，已从上一完整批次恢复（${claim.id}@r${batch.revision}），提交回执未生成`,
        restoredTo: `${claim.id}@r${batch.revision}`
      }
      // 内存状态同样回滚：不应用该次提交
      set((current) => ({ recoveries: [recovery, ...current.recoveries], failNextWrite: false }))
      return { ok: false, message: `写入失败：已从上一完整批次 r${batch.revision} 恢复，WAL ${wal.id} 待启动重放检查` }
    }

    const updatedClaim: Claim = {
      ...structuredClone(claim),
      status: action === '发布' ? '已发布' : '已撤回',
      revision: newRevision,
      version: claim.version + 1,
      updatedAt: timestamp
    }
    const updatedBatch: PublishedBatch = {
      ...structuredClone(batch),
      status: action === '发布' ? '已发布' : '已撤回',
      revision: newRevision,
      approvedBy: action === '发布' ? windowName : batch.approvedBy,
      approvedAt: action === '发布' ? timestamp : batch.approvedAt,
      withdrawnBy: action === '撤回' ? windowName : batch.withdrawnBy,
      withdrawnAt: action === '撤回' ? timestamp : batch.withdrawnAt,
      history: [{ revision: newRevision, action, editor: windowName, note: note || (action === '发布' ? '编辑批准，按冻结依据发布' : '按当前批次修订号撤回'), createdAt: timestamp }, ...batch.history]
    }
    const receipt: ReceiptRecord = {
      id: receiptId, batchId: batch.id, claimId: claim.id, action, attemptedRevision: batch.revision,
      outcome: '已提交', replayCount: 0, createdAt: timestamp
    }
    const auditEntry = auditOf(claim.id, action === '发布' ? '批次批准发布' : '批次撤回', windowName,
      `${batch.id} 按冻结依据 r${batch.revision} 提交，推进至 r${newRevision}；快照${batch.mustReconsider ? '已标注必须复议' : '完整保留'}`, receiptId)
    receipt.auditEntryId = auditEntry.id
    const version: VersionRecord = {
      id: nextId('V'), claimId: claim.id, version: updatedClaim.version, editor: windowName,
      summary: `${action}批次 ${batch.id}：r${batch.revision} → r${newRevision}`,
      changedFactIds: batch.impact.map((item) => item.factId), removedEvidence: [], createdAt: timestamp
    }

    set((current) => ({
      claims: current.claims.map((item) => item.id === claim.id ? updatedClaim : item),
      batches: current.batches.map((item) => item.id === batch.id ? updatedBatch : item),
      receipts: [receipt, ...current.receipts],
      versions: [version, ...current.versions],
      audit: [auditEntry, ...current.audit]
    }))
    // 完整批次落库成功，丢弃 pre-write 日志
    writeWal(null)
    return { ok: true, message: `${action}成功：${batch.id} r${batch.revision} → r${newRevision}（回执 ${receiptId}）`, receiptId }
  }
}, {
  name: 'gsb68:fact-check-workbench',
  partialize: (state) => ({
    claims: state.claims, versions: state.versions, audit: state.audit,
    batches: state.batches, drafts: state.drafts, receipts: state.receipts, recoveries: state.recoveries,
    keyword: state.keyword, status: state.status
  })
}))

/** 持久化水合后执行一次：WAL 恢复 → 旧数据基线迁移 */
let bootGuard = false
export function bootstrapWorkbench() {
  const run = () => {
    if (bootGuard) return
    bootGuard = true
    useClaimStore.setState((state) => migrateOnBoot(recoverOnBoot(state)), false)
  }
  const persistApi = useClaimStore.persist
  if (!persistApi || persistApi.hasHydrated?.()) {
    run()
  } else {
    const unsub = persistApi.onFinishHydration(() => { run(); unsub?.() })
  }
}

function recoverOnBoot(state: ClaimState): ClaimState {
  const wal = readWal()
  if (!wal) return state
  const claims = state.claims.map((claim) => claim.id === wal.snapshot.claim.id ? wal.snapshot.claim : claim)
  const recovery: RecoveryRecord = {
    id: nextId('REC'), at: now(), trigger: '启动恢复', walId: wal.id, batchId: wal.batchId,
    detail: `检测到未完成的批次写入（${wal.action}，WAL ${wal.id}），已从上一完整批次恢复`,
    restoredTo: `${wal.claimId}@r${wal.snapshot.claim.revision ?? 1}`
  }
  writeWal(null)
  return { ...state, claims, recoveries: [recovery, ...state.recoveries] }
}

function migrateOnBoot(state: ClaimState): ClaimState {
  const legacy = state.claims.filter((claim) => claim.revision === undefined)
  if (legacy.length === 0) return state
  const migratedAt = now()
  const entries: AuditEntry[] = []
  const claims = state.claims.map((claim) => {
    if (claim.revision !== undefined) return claim
    for (const fact of claim.facts) {
      for (const source of [...fact.sources, ...fact.counterSources]) {
        if (source.revision === undefined) source.revision = 1
      }
    }
    entries.push(auditOf(claim.id, '旧数据基线化', '系统迁移', `无修订号的历史数据升级为可追溯基线 ${claim.id}@r1`))
    return { ...claim, revision: 1 }
  })
  const recoveries = [{ id: nextId('REC'), at: migratedAt, trigger: '启动恢复' as const, detail: `将 ${legacy.length} 条无修订号主张升级为可追溯基线`, restoredTo: '当前数据 @r1' }, ...state.recoveries]
  return { ...state, claims, audit: [...entries, ...state.audit], recoveries }
}

export const conclusionColor: Record<string, string> = {
  已证实: 'green',
  部分属实: 'yellow',
  证据不足: 'orange',
  不实: 'red'
}
