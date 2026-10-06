import type {
  BatchAction, Claim, ClaimBasis, FactImpact, FrozenFact, FrozenSource,
  PublishedBatch, SourceRecord
} from '../types'

/* ---------------- 冻结：进入复核时固化结论、来源、相反证据 ---------------- */

const freezeSource = (source: SourceRecord): FrozenSource => ({
  id: source.id, title: source.title, url: source.url, publisher: source.publisher,
  publishedAt: source.publishedAt, capturedAt: source.capturedAt, kind: source.kind,
  chainOfCustody: source.chainOfCustody, contentHash: source.contentHash,
  version: source.version, withdrawn: source.withdrawn
})

export function freezeBasis(claim: Claim, frozenBy: string): ClaimBasis {
  return {
    frozenAt: new Date().toISOString(),
    frozenBy,
    claimRevision: claim.revision ?? 1,
    claimStatus: claim.status,
    facts: claim.facts.map<FrozenFact>((fact) => ({
      factId: fact.id,
      text: fact.text,
      conclusion: fact.conclusion,
      confidence: fact.confidence,
      unresolved: [...fact.unresolved],
      sources: fact.sources.map(freezeSource),
      counterSources: fact.counterSources.map(freezeSource)
    }))
  }
}

/* ---------------- 依据差异：之后只按这份依据审阅 ---------------- */

const describeSource = (source: { title: string; version: number; contentHash: string; withdrawn?: boolean }) =>
  `${source.title} V${source.version}（${source.contentHash.slice(0, 18)}${source.withdrawn ? '，已撤下' : ''}）`

function diffEvidences(
  factId: string,
  text: string,
  frozen: FrozenSource[],
  live: SourceRecord[]
): FactImpact[] {
  const impacts: FactImpact[] = []
  const frozenById = new Map(frozen.map((source) => [source.id, source]))
  const liveById = new Map(live.map((source) => [source.id, source]))
  for (const source of live) {
    const old = frozenById.get(source.id)
    if (!old) {
      impacts.push({ factId, text, kind: '证据新增', before: '（无）', after: describeSource(source) })
    } else if (source.version !== old.version || source.contentHash !== old.contentHash) {
      impacts.push({ factId, text, kind: '证据改版', before: describeSource(old), after: describeSource(source) })
    } else if (source.withdrawn && !old.withdrawn) {
      impacts.push({ factId, text, kind: '证据撤下', before: describeSource(old), after: '已撤下（保留留档）' })
    }
  }
  for (const source of frozen) {
    if (!liveById.has(source.id)) {
      impacts.push({ factId, text, kind: '证据撤下', before: describeSource(source), after: '从当前工作区移除' })
    }
  }
  return impacts
}

export function diffBasis(basis: ClaimBasis, claim: Claim): FactImpact[] {
  if (!claim) return basis.facts.map((fact) => ({ factId: fact.factId, text: fact.text, kind: '事实移除', before: fact.conclusion, after: '主张不存在' }))
  const impacts: FactImpact[] = []
  const frozenById = new Map(basis.facts.map((fact) => [fact.factId, fact]))
  const liveById = new Map(claim.facts.map((fact) => [fact.id, fact]))
  for (const live of claim.facts) {
    const old = frozenById.get(live.id)
    if (!old) {
      impacts.push({ factId: live.id, text: live.text, kind: '事实新增', before: '（无）', after: `${live.conclusion} / 置信度${live.confidence}%` })
      continue
    }
    const summary = live.text
    if (live.text !== old.text) impacts.push({ factId: live.id, text: summary, kind: '事实变化', before: old.text, after: live.text })
    if (live.conclusion !== old.conclusion) impacts.push({ factId: live.id, text: summary, kind: '结论变化', before: old.conclusion, after: live.conclusion })
    if (live.confidence !== old.confidence) impacts.push({ factId: live.id, text: summary, kind: '置信度变化', before: `${old.confidence}%`, after: `${live.confidence}%` })
    const beforeUnresolved = old.unresolved.join('；') || '无'
    const afterUnresolved = live.unresolved.join('；') || '无'
    if (afterUnresolved !== beforeUnresolved) impacts.push({ factId: live.id, text: summary, kind: '疑点变化', before: beforeUnresolved, after: afterUnresolved })
    impacts.push(...diffEvidences(live.id, summary, old.sources, live.sources))
    impacts.push(...diffEvidences(live.id, summary, old.counterSources, live.counterSources))
  }
  for (const old of basis.facts) {
    if (!liveById.has(old.factId)) {
      impacts.push({ factId: old.factId, text: old.text, kind: '事实移除', before: `${old.conclusion} / 置信度${old.confidence}%`, after: '（已从事实树删除）' })
    }
  }
  return impacts
}

/** 发布前校验只读取冻结依据，不看工作区实时数据 */
export function preflightBasis(basis: ClaimBasis): string[] {
  const blocking: string[] = []
  if (basis.facts.length === 0) blocking.push('冻结依据中没有可验证事实')
  for (const fact of basis.facts) {
    if (fact.conclusion === '证据不足' && fact.unresolved.length > 0) blocking.push(`${fact.factId} 结论为证据不足且仍有未解决疑点`)
    if (fact.sources.length + fact.counterSources.length === 0) blocking.push(`${fact.factId} 冻结依据中没有来源记录`)
    if ([...fact.sources, ...fact.counterSources].some((source) => source.kind === '待证信息')) blocking.push(`${fact.factId} 待证信息尚未完成原始来源核验`)
    if ([...fact.sources, ...fact.counterSources].some((source) => source.withdrawn)) blocking.push(`${fact.factId} 存在已被撤下的证据`)
  }
  return blocking
}

/* ---------------- 批次修订号冲突差异 ---------------- */

export function revisionConflictDiff(batch: PublishedBatch, liveRevision: number, action: BatchAction, expectedStatus: Claim['status'] | null, actualStatus: Claim['status'] | null): string[] {
  const diff: string[] = [
    `本窗口依据批次修订号 r${batch.revision} 提交「${action}」`,
    `批次当前修订号为 r${liveRevision}（先到动作已推进）`
  ]
  if (batch.mustReconsider) diff.push(`批次自冻结后已积累 ${batch.impact.length} 项依据变化，标注必须复议`)
  if (expectedStatus && actualStatus && expectedStatus !== actualStatus) diff.push(`预期主张状态「${expectedStatus}」，实际为「${actualStatus}」`)
  diff.push('先到结果保持不变，本窗口动作已另存为草稿与差异')
  return diff
}

/* ---------------- 工具 ---------------- */

export const impactKindColor: Record<FactImpact['kind'], string> = {
  事实新增: 'blue',
  事实移除: 'red',
  事实变化: 'orange',
  结论变化: 'red',
  置信度变化: 'orange',
  疑点变化: 'orange',
  证据新增: 'blue',
  证据改版: 'purple',
  证据撤下: 'red'
}

export function formatRevision(revision: number): string {
  return `r${revision}`
}
