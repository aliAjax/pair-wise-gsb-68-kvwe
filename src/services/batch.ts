import type { BatchDrift, BatchDiff, Claim, FactBasis, PublicationBatch, SourceRecord } from '../types'

/** 冻结事实依据：结论、疑点、来源（含相反证据）版本与撤下状态 */
export function freezeBasis(claim: Claim): FactBasis[] {
  return claim.facts.map((fact) => ({
    factId: fact.id,
    text: fact.text,
    conclusion: fact.conclusion,
    confidence: fact.confidence,
    unresolved: [...fact.unresolved],
    sources: [...fact.sources, ...fact.counterSources].map((source) => ({
      id: source.id,
      title: source.title,
      version: source.version,
      retracted: Boolean(source.retracted),
      contentHash: source.contentHash,
      counter: fact.counterSources.includes(source)
    }))
  }))
}

function sourceSignature(source: SourceRecord, counter: boolean) {
  return `${counter ? '相反' : '支持'}证据 ${source.title} V${source.version}${source.retracted ? '（已撤下）' : ''} ${source.contentHash}`
}

/** 以冻结依据为准，逐条核对当前主张：证据版本、结论或疑点变化即产生漂移 */
export function detectDrift(basis: FactBasis[], claim: Claim): BatchDrift[] {
  const drift: BatchDrift[] = []
  for (const frozen of basis) {
    const current = claim.facts.find((fact) => fact.id === frozen.factId)
    if (!current) {
      drift.push({ factId: frozen.factId, kind: '结论', frozen: frozen.text, current: '事实已被删除' })
      continue
    }    if (current.conclusion !== frozen.conclusion) {
      drift.push({ factId: frozen.factId, kind: '结论', frozen: frozen.conclusion, current: current.conclusion })
    }
    const frozenUnresolved = frozen.unresolved.join('；')
    const currentUnresolved = current.unresolved.join('；')
    if (currentUnresolved !== frozenUnresolved) {
      drift.push({ factId: frozen.factId, kind: '疑点', frozen: frozenUnresolved || '（无）', current: currentUnresolved || '（无）' })
    }
    for (const frozenSource of frozen.sources) {
      const list = frozenSource.counter ? current.counterSources : current.sources
      const currentSource = list.find((source) => source.id === frozenSource.id)
      if (!currentSource) {
        drift.push({ factId: frozen.factId, kind: '证据版本', sourceId: frozenSource.id, frozen: `${frozenSource.title} 在档`, current: '证据已被移除' })
      } else if (currentSource.version !== frozenSource.version || Boolean(currentSource.retracted) !== frozenSource.retracted || currentSource.contentHash !== frozenSource.contentHash) {
        drift.push({
          factId: frozen.factId,
          kind: '证据版本',
          sourceId: frozenSource.id,
          frozen: `V${frozenSource.version}${frozenSource.retracted ? ' 已撤下' : ''} ${frozenSource.contentHash}`,
          current: `V${currentSource.version}${currentSource.retracted ? ' 已撤下' : ''} ${currentSource.contentHash}`
        })
      }
    }
  }
  for (const fact of claim.facts) {
    if (!basis.some((frozen) => frozen.factId === fact.id)) {
      drift.push({ factId: fact.id, kind: '结论', frozen: '冻结时不存在', current: `新增事实：${fact.text}` })
    }
  }
  return drift
}

/** 后到动作与先到结果之间的差异：修订号 + 冻结依据到当前依据的逐项差异 */
export function buildDifferences(batch: PublicationBatch, claim: Claim): BatchDiff[] {
  const diffs: BatchDiff[] = [{ label: '批次修订号', expected: `R${batch.batchRev}`, actual: `R${claim.rev ?? 0}` }]
  return diffs.concat(detectDrift(batch.frozenBasis, claim).map((item) => ({
    factId: item.factId,
    label: `${item.kind}${item.sourceId ? ` ${item.sourceId}` : ''}`,
    expected: item.frozen,
    actual: item.current
  })))
}

/** 只按冻结依据做发布前校验（复核窗口不得引用已变化的工作区数据） */
export function preflightBasis(basis: FactBasis[]) {
  const blocking: string[] = []
  for (const fact of basis) {
    if (fact.conclusion === '证据不足' && fact.unresolved.length > 0) blocking.push(`${fact.factId} 结论证据不足且仍有未解决疑点`)
    if (fact.sources.length === 0) blocking.push(`${fact.factId} 没有任何来源或相反证据`)
    if (fact.sources.some((source) => source.title.includes('匿名') || source.contentHash === '')) blocking.push(`${fact.factId} 存在未完成核验的待证信息`)
  }
  return { allowed: blocking.length === 0, blocking }
}

/** 上一完整批次：按主张取最近一个带完整快照的批次，用于写入失败恢复 */
export function lastCompleteBatch(batches: PublicationBatch[], claimId: string): PublicationBatch | undefined {
  return batches.filter((batch) => batch.claimId === claimId && batch.snapshotComplete && batch.snapshotClaim)
    .sort((a, b) => b.batchRev - a.batchRev || b.seq - a.seq)[0]
}

/** 受影响事实（去重） */
export function affectedFactIds(drift: BatchDrift[]): string[] {
  return [...new Set(drift.map((item) => item.factId))]
}

export { sourceSignature }
