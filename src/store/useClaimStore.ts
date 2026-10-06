import { create, type StateCreator } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import { seedAudit, seedClaims, seedVersions } from '../data/seed'
import { buildDifferences, detectDrift, freezeBasis, lastCompleteBatch, preflightBasis } from '../services/batch'
import type { AuditEntry, BatchAction, Claim, ClaimAnnotation, ClaimFact, FactConclusion, PublicationBatch, BatchReceipt, SourceRecord, VersionRecord } from '../types'

interface CommitResult {
  ok: boolean
  message: string
  receipt?: BatchReceipt
  replayed?: boolean
  recoveredTo?: number
}

interface ClaimState {
  claims: Claim[]
  versions: VersionRecord[]
  audit: AuditEntry[]
  batches: PublicationBatch[]
  receipts: BatchReceipt[]
  failNextCommit: boolean
  keyword: string
  status: Claim['status'] | '全部'
  setKeyword: (value: string) => void
  setStatus: (value: Claim['status'] | '全部') => void
  toggleFailNextCommit: (value: boolean) => void
  addClaim: (input: { title: string; summary: string; reporter: string; priority: Claim['priority'] }) => Claim
  updateFact: (claimId: string, factId: string, patch: Partial<ClaimFact>, windowId?: string) => void
  addFact: (claimId: string, text: string, windowId?: string) => void
  addAnnotation: (claimId: string, factId: string, annotation: Omit<ClaimAnnotation, 'id' | 'createdAt' | 'resolved'>) => void
  resolveAnnotation: (claimId: string, factId: string, annotationId: string) => void
  addSource: (claimId: string, factId: string, source: Omit<SourceRecord, 'id' | 'capturedAt' | 'version'>, counter: boolean, windowId?: string) => void
  /** 模拟另一窗口：证据改版（版本号/哈希变化）或撤下证据 */
  changeEvidence: (claimId: string, factId: string, sourceId: string, patch: Partial<Pick<SourceRecord, 'version' | 'retracted' | 'contentHash'>>, windowId?: string) => void
  /** 模拟另一窗口：直接改动结论或疑点 */
  applyOtherWindowEdit: (claimId: string, factId: string, patch: Partial<Pick<ClaimFact, 'conclusion' | 'confidence' | 'unresolved'>>, windowId?: string) => void
  /** 进入复核：冻结结论、来源和相反证据，生成发布批次 */
  submitForReview: (claimId: string, windowId: string, note: string) => { ok: boolean; message: string; batch?: PublicationBatch }
  /** 发布/撤回决策：按批次修订号判断先后，冲突留下草稿与差异 */
  decideBatch: (batchId: string, action: BatchAction, windowId: string, expectedRev?: number, key?: string) => CommitResult
  /** 重放历史回执：幂等返回，不新增审计 */
  replayReceipt: (key: string, windowId: string) => CommitResult
  /** 写入失败后从上一完整批次恢复 */
  recoverFromLastComplete: (claimId: string, receiptKey?: string) => { ok: boolean; recoveredTo?: number; message: string }
  /** 旧数据没有修订号时升级成可追溯基线 */
  upgradeBaselines: () => void
  reset: () => void
}

let idSeed = 100
const nextId = (prefix: string) => `${prefix}-${Date.now()}-${idSeed++}`
const now = () => new Date().toISOString()

function makeAudit(claimId: string, action: string, operator: string, detail: string, receiptId?: string): AuditEntry {
  return { id: nextId('AUD'), claimId, action, operator, detail, createdAt: now(), receiptId }
}

function clone<T>(value: T): T {
  return structuredClone(value)
}

const browserStorage = createJSONStorage(() => {
  const host = globalThis as { localStorage?: Storage }
  if (host.localStorage) return host.localStorage
  // 非浏览器环境（如测试）使用内存存储
  const map = new Map<string, string>()
  return { getItem: (key: string) => (map.has(key) ? map.get(key)! : null), setItem: (key: string, value: string) => void map.set(key, value), removeItem: (key: string) => void map.delete(key) }
})

const claimStoreCreator: StateCreator<ClaimState, [], []> = (set, get) => {
  /** 内容变更：推进主张修订号，并让未批准批次失效、已批准批次标注必须复议 */
  const mutateContent = (claimId: string, windowId: string, action: string, detail: string, mutate: (claim: Claim) => void) => {
    set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      if (!claim) return state
      mutate(claim)
      claim.rev = (claim.rev ?? 0) + 1
      claim.version += 1
      claim.updatedAt = now()

      const batches = state.batches.map((batch) => {
        if (batch.claimId !== claimId) return batch
        if (batch.status !== '复核中' && batch.status !== '已批准') return batch
        const drift = detectDrift(batch.frozenBasis, claim)
        if (drift.length === 0) return batch
        if (batch.status === '复核中') {
          return { ...batch, status: '已失效' as const, drift }
        }
        return { ...batch, drift, mustReconsider: true }
      })
      const invalidated = batches.filter((batch, index) => batch.status === '已失效' && state.batches[index].status === '复核中')
      const reconsider = batches.filter((batch, index) => batch.status === '已批准' && batch.mustReconsider && !state.batches[index].mustReconsider)
      const lines = [`${detail}（修订号 R${claim.rev}，窗口：${windowId}）`]
      if (invalidated.length) lines.push(`未批准批次失效：${invalidated.map((batch) => `${batch.id}，受影响事实 ${[...new Set(batch.drift.map((item) => item.factId))].join('、')}`).join('；')}`)
      if (reconsider.length) lines.push(`已批准批次保留快照但必须复议：${reconsider.map((batch) => batch.id).join('、')}`)
      const audit = [makeAudit(claimId, action, windowId, lines.join('。')), ...state.audit]
      return { claims: [...state.claims], batches, audit }
    })
  }

  return {
    claims: seedClaims,
    versions: seedVersions,
    audit: seedAudit,
    batches: [],
    receipts: [],
    failNextCommit: false,
    keyword: '',
    status: '全部',
    setKeyword: (keyword) => set({ keyword }),
    setStatus: (status) => set({ status }),
    toggleFailNextCommit: (value) => set({ failNextCommit: value }),

    addClaim: (input) => {
      const stamp = now()
      const claim: Claim = { id: nextId('FC'), ...input, editor: '宋卓', status: '核查中', createdAt: stamp, updatedAt: stamp, version: 1, rev: 1, facts: [] }
      set((state) => ({ claims: [claim, ...state.claims], audit: [makeAudit(claim.id, '建立核查主张', input.reporter, `新主张自 R1 起纳入批次修订追踪`), ...state.audit] }))
      return claim
    },

    addFact: (claimId, text, windowId = '主窗口') => {
      if (!text.trim()) return
      mutateContent(claimId, windowId, '拆分可验证事实', `新增事实：${text}`, (claim) => {
        claim.facts.push({ id: nextId('F'), text, conclusion: '证据不足', confidence: 30, unresolved: ['尚未关联来源'], sources: [], counterSources: [], annotations: [] })
      })
    },

    updateFact: (claimId, factId, patch, windowId = '主窗口') => {
      const claim = get().claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return
      if (patch.conclusion && patch.conclusion !== '证据不足' && fact.unresolved.length) {
        patch.confidence = Math.min(patch.confidence ?? fact.confidence, 75)
      }
      const changed = [patch.conclusion && patch.conclusion !== fact.conclusion ? `结论→${patch.conclusion}` : '', patch.unresolved ? `疑点更新` : '', patch.confidence !== undefined && patch.confidence !== fact.confidence ? `置信度→${patch.confidence}%` : ''].filter(Boolean).join('，') || '事实更新'
      mutateContent(claimId, windowId, '更新事实结论', `${fact.text}：${changed}`, (target) => {
        const targetFact = target.facts.find((item) => item.id === factId)!
        Object.assign(targetFact, patch)
      })
    },

    addAnnotation: (claimId, factId, input) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return state
      fact.annotations.unshift({ ...input, id: nextId('N'), createdAt: now(), resolved: false })
      // 批注不改变发布依据，不推进批次修订号
      return { claims: [...state.claims], audit: [makeAudit(claimId, '添加批注', input.author, input.content), ...state.audit] }
    }),

    resolveAnnotation: (claimId, factId, annotationId) => set((state) => {
      const claim = state.claims.find((item) => item.id === claimId)
      const annotation = claim?.facts.find((item) => item.id === factId)?.annotations.find((item) => item.id === annotationId)
      if (!claim || !annotation) return state
      annotation.resolved = true
      return { claims: [...state.claims], audit: [makeAudit(claimId, '解决批注', '当前用户', annotation.content), ...state.audit] }
    }),

    addSource: (claimId, factId, input, counter, windowId = '主窗口') => {
      const claim = get().claims.find((item) => item.id === claimId)
      const fact = claim?.facts.find((item) => item.id === factId)
      if (!claim || !fact) return
      const list = counter ? fact.counterSources : fact.sources
      mutateContent(claimId, windowId, counter ? '保留相反证据' : '关联来源', `${counter ? '相反证据' : '支持证据'}：${input.title}`, (target) => {
        const targetFact = target.facts.find((item) => item.id === factId)!
        const targetList = counter ? targetFact.counterSources : targetFact.sources
        const sameTitle = targetList.filter((item) => item.title === input.title).length
        targetList.unshift({ ...input, id: nextId(counter ? 'C' : 'S'), capturedAt: now(), version: sameTitle + 1 })
      })
    },

    changeEvidence: (claimId, factId, sourceId, patch, windowId = '另一窗口') => {
      mutateContent(claimId, windowId, '证据改版或撤下', `证据 ${sourceId} 被${patch.retracted ? '撤下' : '改版'}`, (claim) => {
        for (const fact of claim.facts) {
          for (const source of [...fact.sources, ...fact.counterSources]) {
            if (source.id === sourceId) Object.assign(source, patch)
          }
        }
      })
    },

    applyOtherWindowEdit: (claimId, factId, patch, windowId = '另一窗口') => {
      const fact = get().claims.find((item) => item.id === claimId)?.facts.find((item) => item.id === factId)
      if (!fact) return
      mutateContent(claimId, windowId, '他窗改动发布依据', `${fact.text}：结论/疑点被修改`, (claim) => {
        const target = claim.facts.find((item) => item.id === factId)!
        Object.assign(target, patch)
      })
    },

    submitForReview: (claimId, windowId, note) => {
      const claim = get().claims.find((item) => item.id === claimId)
      if (!claim) return { ok: false, message: '主张不存在' }
      if (claim.facts.length === 0) return { ok: false, message: '至少需要一项可验证事实' }
      const stamp = now()
      const frozenClaim = clone(claim)
      frozenClaim.rev = (claim.rev ?? 0) + 1
      frozenClaim.status = '待编辑复核'
      frozenClaim.version = claim.version + 1
      frozenClaim.updatedAt = stamp
      const basis = freezeBasis(frozenClaim)
      const seq = get().batches.filter((batch) => batch.claimId === claimId).length
      const batch: PublicationBatch = {
        id: nextId('PB'),
        claimId,
        seq,
        status: '复核中',
        baseRev: frozenClaim.rev,
        batchRev: frozenClaim.rev,
        windowId,
        frozenAt: stamp,
        frozenBasis: basis,
        frozenClaimStatus: claim.status,
        drift: [],
        snapshotClaim: frozenClaim,
        snapshotLabel: '进入复核冻结',
        snapshotComplete: true
      }
      const version: VersionRecord = { id: nextId('V'), claimId, version: frozenClaim.version, editor: claim.editor || windowId, summary: note || '进入编辑复核，冻结发布批次依据', changedFactIds: basis.map((item) => item.factId), removedEvidence: [], createdAt: stamp }
      set((state) => ({ claims: [frozenClaim, ...state.claims.filter((item) => item.id !== claimId)], batches: [batch, ...state.batches], versions: [version, ...state.versions], audit: [makeAudit(claimId, '进入复核并冻结批次', windowId, `${batch.id} 冻结 ${basis.length} 项事实的结论、来源与相反证据 @R${batch.batchRev}`), ...state.audit] }))
      return { ok: true, message: `批次 ${batch.id} 已冻结，复核只按此依据审阅`, batch }
    },

    decideBatch: (batchId, action, windowId, expectedRevArg, keyArg) => {
      const state = get()
      const batch = state.batches.find((item) => item.id === batchId)
      if (!batch) return { ok: false, message: '批次不存在' }
      const claim = state.claims.find((item) => item.id === batch.claimId)
      if (!claim) return { ok: false, message: '主张不存在' }
      const expectedRev = expectedRevArg ?? batch.batchRev
      const key = keyArg || `${batchId}:${action}:${windowId}:R${expectedRev}`

      // 重放回执：幂等，不新增审计
      const existing = state.receipts.find((item) => item.key === key)
      if (existing) {
        if (!existing.replayed) {
          set((current) => ({ receipts: current.receipts.map((item) => item.key === key ? { ...item, replayed: true } : item) }))
        }
        return { ok: true, message: `回执重放（幂等，无新增审计）：${existing.result}`, receipt: existing, replayed: true }
      }

      const canExecute =
        (batch.status === '复核中' && expectedRev === batch.batchRev) ||
        (batch.status === '已批准' && action === '撤回' && expectedRev === batch.batchRev && !batch.mustReconsider)

      if (!canExecute) {
        // 后到动作：不覆盖先到结果，留下冲突草稿和差异
        const stamp = now()
        const draftBatch: PublicationBatch = {
          ...clone(batch),
          id: nextId('PB'),
          seq: state.batches.filter((item) => item.claimId === batch.claimId).length,
          status: '冲突草稿',
          windowId,
          frozenAt: stamp,
          decidedAt: stamp,
          drift: detectDrift(batch.frozenBasis, claim),
          lateDraft: { action, windowId, expectedRev, actualRev: claim.rev ?? batch.batchRev, differences: buildDifferences(batch, claim), arrivedAt: stamp, idempotencyKey: key },
          snapshotClaim: undefined,
          snapshotLabel: '冲突草稿（无快照）',
          snapshotComplete: false,
          isBaseline: false
        }
        const receipt: BatchReceipt = { key, batchId: draftBatch.id, claimId: claim.id, action, windowId, result: '冲突草稿', rev: claim.rev ?? 0, createdAt: stamp }
        set((current) => ({
          batches: [draftBatch, ...current.batches],
          receipts: [receipt, ...current.receipts],
          audit: [makeAudit(claim.id, '后到动作冲突留草稿', windowId, `${action}（依据 R${expectedRev}）与先到结果 ${batch.status} @R${batch.batchRev} 冲突，保留草稿 ${draftBatch.id} 与差异，未覆盖先到结果`, key), ...current.audit]
        }))
        return { ok: false, message: `修订号冲突：动作基于 R${expectedRev}，批次已在 R${batch.batchRev}（${batch.status}），已留草稿`, receipt }
      }

      if (action === '发布') {
        const preflight = preflightBasis(batch.frozenBasis)
        if (!preflight.allowed) {
          return { ok: false, message: `冻结依据未通过发布前校验：${preflight.blocking.join('；')}` }
        }
      }

      // 模拟分阶段写入：失败则从上一完整批次恢复
      if (state.failNextCommit) {
        set({ failNextCommit: false })
        const recovery = get().recoverFromLastComplete(claim.id, key)
        return { ok: false, message: `写入失败，已从上一完整批次恢复至 R${recovery.recoveredTo}，未产生发布结果`, recoveredTo: recovery.recoveredTo }
      }

      const stamp = now()
      const targetStatus = action === '发布' ? '已发布' as const : '已撤回' as const
      const updatedClaim = clone(claim)
      updatedClaim.status = targetStatus
      updatedClaim.rev = (batch.batchRev) + 1
      updatedClaim.version = claim.version + 1
      updatedClaim.updatedAt = stamp

      const updatedBatch: PublicationBatch = {
        ...batch,
        status: action === '发布' ? '已批准' : '已撤回',
        decidedAt: stamp,
        batchRev: updatedClaim.rev,
        snapshotClaim: clone(updatedClaim),
        snapshotLabel: `${action}完成快照`,
        snapshotComplete: true,
        lateDraft: undefined
      }
      const receipt: BatchReceipt = { key, batchId: batch.id, claimId: claim.id, action, windowId, result: action === '发布' ? '已批准' : '已撤回', rev: updatedClaim.rev, createdAt: stamp }
      const version: VersionRecord = { id: nextId('V'), claimId: claim.id, version: updatedClaim.version, editor: claim.editor || windowId, summary: `批次 ${batch.id} ${action}，只按冻结依据决策 @R${updatedClaim.rev}`, changedFactIds: batch.frozenBasis.map((item) => item.factId), removedEvidence: [], createdAt: stamp }
      set((current) => ({
        claims: [updatedClaim, ...current.claims.filter((item) => item.id !== claim.id)],
        batches: current.batches.map((item) => item.id === batch.id ? updatedBatch : item),
        versions: [version, ...current.versions],
        receipts: [receipt, ...current.receipts],
        audit: [makeAudit(claim.id, action === '发布' ? '批准发布批次' : '撤回已发布批次', windowId, `${batch.id} 按冻结依据${action}，批次修订号 R${updatedBatch.baseRev}→R${updatedBatch.batchRev}`, key), ...current.audit]
      }))
      return { ok: true, message: `批次已${action === '发布' ? '批准发布' : '撤回'} @R${updatedClaim.rev}`, receipt }
    },

    replayReceipt: (key, windowId) => {
      const receipt = get().receipts.find((item) => item.key === key)
      if (!receipt) return { ok: false, message: '回执不存在' }
      if (!receipt.replayed) {
        set((state) => ({ receipts: state.receipts.map((item) => item.key === key ? { ...item, replayed: true } : item) }))
      }
      return { ok: true, message: `窗口 ${windowId} 重放回执 ${receipt.result}（幂等，无新增审计）`, receipt: { ...receipt, replayed: true }, replayed: true }
    },

    recoverFromLastComplete: (claimId, receiptKey) => {
      const state = get()
      const complete = lastCompleteBatch(state.batches.filter((batch) => !batch.isBaseline), claimId)
      const fallback = lastCompleteBatch(state.batches, claimId)
      const target = complete ?? fallback
      if (!target?.snapshotClaim) return { ok: false, message: '没有可恢复的完整批次快照' }
      const restored = clone(target.snapshotClaim)
      set((current) => ({
        claims: [restored, ...current.claims.filter((item) => item.id !== claimId)],
        audit: [makeAudit(claimId, '写入失败恢复', '系统', `批次写入不完整，已从上一完整批次 ${target.id}（${target.snapshotLabel}）恢复至 R${restored.rev}`, receiptKey), ...current.audit]
      }))
      return { ok: true, recoveredTo: restored.rev, message: `已恢复至 ${target.id} @R${restored.rev}` }
    },

    upgradeBaselines: () => {
      const state = get()
      const legacy = state.claims.filter((claim) => claim.rev === undefined)
      if (legacy.length === 0) return
      const stamp = now()
      const claims = state.claims.map((claim) => claim.rev === undefined ? { ...claim, rev: 0 } : claim)
      const baselineBatches: PublicationBatch[] = []
      const baselineAudit: AuditEntry[] = []
      for (const claim of legacy) {
        const upgraded = claims.find((item) => item.id === claim.id)!
        baselineBatches.push({
          id: `PB-BASE-${claim.id}`,
          claimId: claim.id,
          seq: 0,
          status: '基线',
          baseRev: 0,
          batchRev: 0,
          windowId: '系统迁移',
          frozenAt: claim.updatedAt,
          frozenBasis: freezeBasis({ ...claim, rev: 0 }),
          frozenClaimStatus: claim.status,
          drift: [],
          snapshotClaim: clone(upgraded),
          snapshotLabel: '旧数据可追溯基线',
          snapshotComplete: true,
          isBaseline: true
        })
        baselineAudit.push(makeAudit(claim.id, '旧数据升级可追溯基线', '系统', `原记录无批次修订号，升级为基线 R0，保存完整快照`))
      }
      set((current) => ({ claims, batches: [...current.batches.filter((batch) => !batch.isBaseline), ...baselineBatches], audit: [...current.audit, ...baselineAudit] }))
    },

    reset: () => {
      idSeed = 100
      set({ claims: clone(seedClaims), versions: clone(seedVersions), audit: clone(seedAudit), batches: [], receipts: [], failNextCommit: false, keyword: '', status: '全部' })
      get().upgradeBaselines()
    }
  }
}

export const useClaimStore = create<ClaimState>()(persist(claimStoreCreator, {
  name: 'gsb68:fact-check-workbench',
  version: 2,
  storage: browserStorage,
  partialize: (state) => ({ claims: state.claims, versions: state.versions, audit: state.audit, batches: state.batches, receipts: state.receipts })
}))

// 旧数据升级在水合后执行一次
queueMicrotask(() => useClaimStore.getState().upgradeBaselines())

// 跨窗口（浏览器标签页）同步：后到动作直接按同步后的批次修订号判断
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (event) => {
    if (event.key !== 'gsb68:fact-check-workbench' || !event.newValue) return
    try {
      const parsed = JSON.parse(event.newValue) as { state?: Partial<ClaimState> }
      if (parsed.state) useClaimStore.setState(parsed.state)
    } catch {
      // 快照损坏时忽略，等待下一条完整状态
    }
  })
}

export const conclusionColor: Record<FactConclusion, string> = {
  已证实: 'green',
  部分属实: 'yellow',
  证据不足: 'orange',
  不实: 'red'
}
