// 发布批次逻辑冒烟测试：冻结/漂移/修订号冲突/幂等回执/写入恢复/旧数据基线
const mem = new Map<string, string>()
;(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size }
} as Storage

const failures: string[] = []
const check = (name: string, cond: boolean, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`)
  if (!cond) failures.push(name)
}

await new Promise((resolve) => setTimeout(resolve, 0)) // 等基线升级 microtask
const { useClaimStore } = await import('../src/store/useClaimStore.ts')
const store = useClaimStore.getState

await new Promise((resolve) => setTimeout(resolve, 0))

// 0. 旧数据无修订号 → 升级 R0 可追溯基线
let s = store()
check('旧数据全部升级 rev=0', s.claims.every((c) => c.rev === 0))
check('为每条旧数据生成基线批次', s.batches.filter((b) => b.isBaseline).length === 2)
check('基线升级写入审计', s.audit.some((a) => a.action === '旧数据升级可追溯基线'))

const C = 'FC-260928-03' // F-4 已证实有源、F-5 不实有相反证据，可发布

// 1. 窗口A进入复核 → 冻结依据
let r = store().submitForReview(C, '窗口A', '提交复核')
s = store()
let batch = s.batches.find((b) => b.id === r.batch!.id)!
check('进入复核生成复核中批次', batch.status === '复核中')
check('冻结时修订号推进到 R1', batch.baseRev === 1 && s.claims.find((c) => c.id === C)!.rev === 1)
check('冻结两项事实依据', batch.frozenBasis.length === 2)
check('冻结依据包含相反证据', batch.frozenBasis.find((b) => b.factId === 'F-5')!.sources.some((x) => x.counter))

// 2. 复核期间窗口B改版证据 → 未批准批次失效并列受影响事实
store().changeEvidence(C, 'F-4', 'S-5', { version: 2, contentHash: 'sha256:changed' }, '窗口B')
s = store()
batch = s.batches.find((b) => b.id === batch.id)!
check('证据改版后未批准批次失效', batch.status === '已失效')
check('失效批次列出受影响事实 F-4', batch.drift.some((d) => d.factId === 'F-4' && d.kind === '证据版本'))
check('失效审计写明受影响事实', s.audit[0].detail.includes('受影响事实'))

// 3. 对失效批次做发布 → 后到动作留冲突草稿，先到结果（已失效）不被覆盖
r = store().decideBatch(batch.id, '发布', '窗口A', batch.baseRev)
s = store()
check('失效批次决策返回冲突', !r.ok)
check('留下冲突草稿批次', s.batches.some((b) => b.status === '冲突草稿' && b.lateDraft?.action === '发布'))
check('草稿带修订号差异', s.batches.find((b) => b.status === '冲突草稿')!.lateDraft!.differences.some((d) => d.label === '批次修订号'))
check('原批次仍为已失效未被覆盖', s.batches.find((b) => b.id === batch.id)!.status === '已失效')

// 4. 重新冻结并批准发布
r = store().submitForReview(C, '窗口A', '重新冻结')
const batch2Id = r.batch!.id
const batch2Base = r.batch!.baseRev
r = store().decideBatch(batch2Id, '发布', '窗口A', batch2Base)
s = store()
check('按冻结依据批准发布', r.ok && s.claims.find((c) => c.id === C)!.status === '已发布')
const approvedRev = s.claims.find((c) => c.id === C)!.rev!
check('批准后修订号在冻结基础上 +1', approvedRev === batch2Base + 1)
check('批准批次保留完整快照', s.batches.find((b) => b.id === batch2Id)!.snapshotComplete === true)
const key = r.receipt!.key

// 5. 重放回执 → 幂等，不新增审计
const auditBefore = store().audit.length
const receiptsBefore = store().receipts.length
const rp = store().replayReceipt(key, '窗口B')
s = store()
check('回执重放成功且标记 replayed', rp.ok && rp.replayed === true)
check('重放不新增审计', s.audit.length === auditBefore, `audit ${auditBefore}→${s.audit.length}`)
check('重放不新增回执', s.receipts.length === receiptsBefore)

// 6. 已批准后窗口B撤下证据 → 快照保留 + 必须复议，撤回被拒并留草稿
store().changeEvidence(C, 'F-4', 'S-5', { retracted: true }, '窗口B')
s = store()
const approvedBatch = s.batches.find((b) => b.id === batch2Id)!
check('已批准批次状态不变', approvedBatch.status === '已批准')
check('已批准批次标注必须复议', approvedBatch.mustReconsider === true)
check('复议批次保留漂移与受影响事实', approvedBatch.drift.some((d) => d.factId === 'F-4'))
const withdraw = store().decideBatch(batch2Id, '撤回', '窗口A', approvedBatch.batchRev)
s = store()
check('必须复议时撤回不覆盖，留草稿', !withdraw.ok && s.batches.some((b) => b.status === '冲突草稿' && b.lateDraft?.action === '撤回'))

// 7. 重新冻结+批准，再模拟下次写入失败 → 从上一完整批次恢复
store().submitForReview(C, '窗口A', '复议后重新冻结')
const b3 = store().batches.find((b) => b.claimId === C && b.status === '复核中')!
store().decideBatch(b3.id, '发布', '窗口A', b3.baseRev)
const revAfterSecondApprove = store().claims.find((c) => c.id === C)!.rev
store().toggleFailNextCommit(true)
const fail = store().decideBatch(b3.id, '撤回', '窗口A', store().claims.find((c) => c.id === C)!.rev)
s = store()
check('写入失败被上报', !fail.ok && fail.message.includes('写入失败'))
check('已从上一完整批次恢复', fail.recoveredTo === revAfterSecondApprove)
check('恢复后主张回到上一批次已发布状态', s.claims.find((c) => c.id === C)!.status === '已发布' && s.claims.find((c) => c.id === C)!.rev === revAfterSecondApprove)
check('恢复事件写入审计', s.audit[0].action === '写入失败恢复')
check('失败标志只生效一次', store().failNextCommit === false)

// 8. 双窗口并发：复核中批次，窗口B携带旧修订号发布 → 草稿+差异，窗口A结果优先
const C2 = 'FC-260929-01'
// 让该主张可发布：清掉 F-2/F-3 疑点并把结论改掉
const st = store()
st.updateFact(C2, 'F-2', { conclusion: '部分属实', unresolved: [] }, '窗口A')
st.updateFact(C2, 'F-3', { conclusion: '部分属实', unresolved: [] }, '窗口A')
const rr = store().submitForReview(C2, '窗口A', '并发演示冻结')
const b4 = rr.batch!
const concurrent = store().decideBatch(b4.id, '发布', '窗口B', b4.baseRev - 1)
s = store()
check('后到旧修订号动作判为冲突', !concurrent.ok)
check('先到批次仍保持复核中未覆盖', s.batches.find((b) => b.id === b4.id)!.status === '复核中')
check('冲突草稿记录双方修订号', s.batches.find((b) => b.lateDraft?.idempotencyKey === concurrent.receipt!.key)!.lateDraft!.actualRev === b4.baseRev)

// 9. 结论/疑点漂移也触发失效（不只是证据版本）
store().updateFact(C2, 'F-1', { conclusion: '部分属实' }, '窗口B')
s = store()
check('结论变化导致复核批次失效', s.batches.find((b) => b.id === b4.id)!.status === '已失效')

if (failures.length) {
  console.error(`\n${failures.length} 项失败`)
  process.exit(1)
}
console.log('\n全部通过')
