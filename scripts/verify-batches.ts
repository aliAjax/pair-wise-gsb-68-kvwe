import './localstorage-shim'
import assert from 'node:assert'
import { bootstrapWorkbench, useClaimStore } from '../src/store/useClaimStore'
import { seedClaims } from '../src/data/seed'

let pass = 0
const check = (name: string, fn: () => void) => { fn(); pass++; console.log(`  ✓ ${name}`) }

// 1. 旧数据基线迁移
bootstrapWorkbench()
let state = useClaimStore.getState()
check('旧数据无修订号时升级为可追溯基线 @r1', () => {
  assert(state.claims.every((c) => c.revision === 1))
  assert(state.audit.some((a) => a.action === '旧数据基线化'))
  assert(state.recoveries.some((r) => r.detail.includes('可追溯基线')))
})

const claimId = seedClaims[0].id // 待编辑复核的演示主张
const s = () => useClaimStore.getState()

// 让冻结依据可发布：把“证据不足+疑点”事实改为已证实且消除待证信息
const claim0 = s().claims.find((c) => c.id === claimId)!
const f2 = claim0.facts.find((f) => f.id === 'F-2')!
useClaimStore.getState().updateFact(claimId, 'F-2', { conclusion: '已证实', confidence: 80, unresolved: [] })
// F-2 的支持证据是“待证信息”，需要移除发布阻断：补充一条原始证据并撤下待证信息
useClaimStore.getState().addSource(claimId, 'F-2', {
  title: '主管部门书面确认函', url: 'https://example.gov.cn/confirm/9901', publisher: '主管部门',
  publishedAt: '2026-09-30', kind: '原始证据', chainOfCustody: '公文交换系统原件留存', contentHash: 'sha256:abc111...2222'
}, false)
const pendingSourceId = f2.sources.find((x) => x.kind === '待证信息')!.id
useClaimStore.getState().removeSource(claimId, 'F-2', pendingSourceId, false, '已取得书面原件，待证截图不再进入发布依据')
// F-3 同样处理
useClaimStore.getState().updateFact(claimId, 'F-3', { conclusion: '部分属实', confidence: 80, unresolved: [] })
useClaimStore.getState().addSource(claimId, 'F-3', {
  title: '消防验收意见书', url: 'https://example.gov.cn/fire/77', publisher: '住建部门',
  publishedAt: '2026-09-30', kind: '原始证据', chainOfCustody: '官网公示PDF留档', contentHash: 'sha256:def333...4444'
}, false)

const revisionBeforeReview = s().claims.find((c) => c.id === claimId)!.revision!
const entered = s().enterReview(claimId, '测试冻结')
check('进入复核冻结结论、来源与相反证据', () => {
  assert(entered.ok, entered.message)
  const batch = s().batches[0]
  assert.equal(batch.status, '复核中')
  assert.equal(batch.revision, revisionBeforeReview)
  assert.equal(batch.basis.facts.length, 3)
  assert(batch.basis.facts.some((f) => f.counterSources.length > 0))
})
const batchId = entered.batchId!
const frozenRev = s().batches.find((b) => b.id === batchId)!.revision

// 2. 复核期间另一窗口改版：未批准批次失效，列受影响事实
const auditCountBefore = s().audit.length
useClaimStore.getState().updateFact(claimId, 'F-1', { conclusion: '部分属实', confidence: 88 })
check('证据版本/结论变化后未批准批次失效并列出受影响事实', () => {
  const batch = s().batches.find((b) => b.id === batchId)!
  assert.equal(batch.status, '已失效')
  assert(batch.impact.some((i) => i.factId === 'F-1' && i.kind === '结论变化'))
  assert.equal(s().claims.find((c) => c.id === claimId)!.revision, frozenRev + 1)
})

// 失效批次不能提交发布 -> 存草稿
const staleSubmit = s().submitBatch(batchId, '发布', frozenRev, '窗口B·林澈', '迟到发布')
check('失效批次提交转为冲突草稿，不覆盖任何结果', () => {
  assert.equal(staleSubmit.ok, false)
  assert(staleSubmit.draftId)
  assert.equal(s().batches.find((b) => b.id === batchId)!.status, '已失效')
})

// 重新冻结提交复核（新批次）
const entered2 = s().enterReview(claimId, '重新冻结')
assert(entered2.ok, entered2.message)
const batchId2 = entered2.batchId!
const rev2 = s().batches.find((b) => b.id === batchId2)!.revision

// 3. 两窗口同时发布：先到成功推进修订号，后到按修订号冲突留草稿
const r1 = s().submitBatch(batchId2, '发布', rev2, '窗口A·宋卓', '先到发布')
check('先到窗口发布成功并推进批次修订号', () => {
  assert(r1.ok, r1.message)
  assert.equal(s().batches.find((b) => b.id === batchId2)!.revision, rev2 + 1)
  assert.equal(s().claims.find((c) => c.id === claimId)!.status, '已发布')
})
const auditAfterFirst = s().audit.length
const r2 = s().submitBatch(batchId2, '发布', rev2, '窗口B·林澈', '后到发布')
check('后到窗口按修订号裁决：落后即留草稿与差异，不覆盖先到结果', () => {
  assert.equal(r2.ok, false)
  assert(r2.draftId)
  const draft = s().drafts.find((d) => d.id === r2.draftId)!
  assert.equal(draft.attemptedRevision, rev2)
  assert.equal(draft.currentRevision, rev2 + 1)
  assert(draft.diff.some((line) => line.includes('r' + (rev2 + 1))))
  // 先到结果保持
  assert.equal(s().batches.find((b) => b.id === batchId2)!.status, '已发布')
  assert.equal(s().batches.find((b) => b.id === batchId2)!.approvedBy, '窗口A·宋卓')
  assert.equal(s().audit.length, auditAfterFirst + 1) // 仅冲突审计
})

// 4. 已批准批次发布后证据再变：快照保留 + 必须复议
const approvedRev = s().batches.find((b) => b.id === batchId2)!.revision
const snapshotFacts = JSON.stringify(s().batches.find((b) => b.id === batchId2)!.basis)
useClaimStore.getState().withdrawSource(claimId, 'F-1', 'S-1', false, '另一窗口撤下来源')
check('已批准批次保留冻结快照但标注必须复议', () => {
  const batch = s().batches.find((b) => b.id === batchId2)!
  assert.equal(batch.status, '已发布') // 状态不变
  assert.equal(batch.mustReconsider, true)
  assert(batch.impact.some((i) => i.kind === '证据撤下'))
  assert.equal(JSON.stringify(batch.basis), snapshotFacts) // 快照不动
  assert.equal(batch.revision, approvedRev) // 证据改版不回改已批准批次修订号
})

// 5. 两窗口撤回：先到撤回成功，后到撤回（持旧修订号+状态不符）留草稿
const withdrawA = s().submitBatch(batchId2, '撤回', approvedRev, '窗口A·宋卓', '先到撤回')
check('先到窗口撤回成功', () => {
  assert(withdrawA.ok, withdrawA.message)
  assert.equal(s().batches.find((b) => b.id === batchId2)!.status, '已撤回')
})
const withdrawB = s().submitBatch(batchId2, '撤回', approvedRev, '窗口B·林澈', '后到撤回')
check('后到撤回冲突存草稿，先到撤回结果不被覆盖', () => {
  assert.equal(withdrawB.ok, false)
  assert(withdrawB.draftId)
  assert.equal(s().batches.find((b) => b.id === batchId2)!.status, '已撤回')
})

// 6. 回执重放不新增审计
const receiptId = r1.receiptId!
const auditBeforeReplay = s().audit.length
const replay1 = s().replayReceipt(receiptId)
const replay2 = s().replayReceipt(receiptId)
check('重放回执返回原始结果且不新增审计', () => {
  assert(replay1.message.includes('重放') && replay1.message.includes('第 1 次重放'))
  assert(replay2.message.includes('第 2 次重放'))
  assert.equal(s().audit.length, auditBeforeReplay)
  assert.equal(s().receipts.find((x) => x.id === receiptId)!.replayCount, 2)
})

// 草稿回执也可重放
const draftReceipt = r2.receiptId!
const before2 = s().audit.length
s().replayReceipt(draftReceipt)
check('冲突草稿回执重放同样不新增审计', () => {
  assert.equal(s().audit.length, before2)
})

// 7. 写入失败：上一完整批次恢复，无新回执
const claim2Id = seedClaims[1].id
// 让第二个主张可发布
const c2 = s().claims.find((c) => c.id === claim2Id)!
c2.facts.forEach(() => {})
useClaimStore.getState().enterReview(claim2Id, '第二个批次')
const batch3 = s().batches.find((b) => b.claimId === claim2Id && b.status === '复核中')!
const recoveriesBefore = s().recoveries.length
const receiptsBefore = s().receipts.length
useClaimStore.getState().setFailNextWrite(true)
const failed = s().submitBatch(batch3.id, '发布', batch3.revision, '窗口A·宋卓', '应当失败的发布')
check('写入失败后从上一完整批次恢复且不产生回执', () => {
  assert.equal(failed.ok, false)
  assert(failed.message.includes('恢复'))
  assert.equal(s().batches.find((b) => b.id === batch3.id)!.revision, batch3.revision)
  assert.equal(s().batches.find((b) => b.id === batch3.id)!.status, '复核中')
  assert.equal(s().receipts.length, receiptsBefore)
  assert.equal(s().recoveries.length, recoveriesBefore + 1)
  assert((globalThis as any).localStorage.getItem('gsb68:batch-wal'))
})

// 8. WAL 保留上一完整批次快照（页面刷新时启动恢复将消费它）
check('WAL 记录的是上一完整批次快照（供重启恢复）', () => {
  const wal = JSON.parse((globalThis as any).localStorage.getItem('gsb68:batch-wal'))
  assert.equal(wal.batchId, batch3.id)
  assert.equal(wal.snapshot.claim.revision, batch3.revision)
  assert(wal.phase === 'pre-write')
})

// 9. 新批次成功发布（失败标志只生效一次）
const okAfter = s().submitBatch(batch3.id, '发布', batch3.revision, '窗口A·宋卓', '恢复后重新发布')
check('恢复后重新提交成功，修订号正常推进', () => {
  assert(okAfter.ok, okAfter.message)
  assert.equal((globalThis as any).localStorage.getItem('gsb68:batch-wal'), null)
})

// 10. 批注不推进修订号、不触发失效
const revBeforeAnnotation = s().claims.find((c) => c.id === claim2Id)!.revision
const batch3Now = s().batches.find((b) => b.id === batch3.id)!
const reconsiderBefore = batch3Now.mustReconsider
useClaimStore.getState().addAnnotation(claim2Id, c2.facts[0].id, { author: '陆衡', role: '事实核查员', content: '批注不影响冻结依据' })
check('批注不推进修订号、不令已批准批次进入复议', () => {
  assert.equal(s().claims.find((c) => c.id === claim2Id)!.revision, revBeforeAnnotation)
  assert.equal(s().batches.find((b) => b.id === batch3.id)!.mustReconsider, reconsiderBefore)
})

console.log(`\n全部 ${pass} 项检查通过`)
