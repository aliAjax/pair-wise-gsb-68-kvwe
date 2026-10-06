import axios from 'axios'
import type { Claim } from '../types'

const client = axios.create({ baseURL: import.meta.env.VITE_API_BASE_URL || '/api', timeout: 5000 })

export async function loadClaimSnapshot(fallback: Claim[]): Promise<Claim[]> {
  if (!import.meta.env.VITE_API_BASE_URL) return fallback
  try { return (await client.get<Claim[]>('/claims')).data } catch { return fallback }
}

export async function preflightPublish(claim: Claim) {
  const blocking: string[] = []
  if (claim.facts.some((fact) => fact.conclusion === '证据不足' && fact.unresolved.length)) blocking.push('仍有证据不足且未解决疑点的事实')
  if (claim.facts.some((fact) => fact.sources.length + fact.counterSources.length === 0)) blocking.push('存在没有来源记录的事实')
  if (claim.facts.flatMap((fact) => fact.sources).some((source) => source.kind === '待证信息')) blocking.push('待证信息尚未完成原始来源核验')
  return { allowed: blocking.length === 0, blocking }
}
