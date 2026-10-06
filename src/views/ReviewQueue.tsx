import { useMemo, useState } from 'react'
import { Badge, Box, Button, Flex, Grid, HStack, Input, Switch, Tab, TabList, TabPanel, TabPanels, Tabs, Tag, Text, Textarea, useToast } from '@chakra-ui/react'
import { impactKindColor, preflightBasis } from '../services/batchEngine'
import { useClaimStore } from '../store/useClaimStore'
import type { ConflictDraft, PublishedBatch } from '../types'

const batchStatusColor: Record<string, string> = { 复核中: 'orange', 已失效: 'red', 已发布: 'green', 已撤回: 'gray' }

export function ReviewQueue() {
  const state = useClaimStore()
  const toast = useToast()
  const reviewBatches = state.batches.filter((batch) => batch.status === '复核中')
  const invalidBatches = state.batches.filter((batch) => batch.status === '已失效')
  const approvedBatches = state.batches.filter((batch) => batch.status === '已发布' || batch.status === '已撤回')
  const pendingDrafts = state.drafts.filter((draft) => draft.resolution === '待处理')

  const submit = (batchId: string, action: '发布' | '撤回', revision: number, windowName: string, note: string) => {
    const result = state.submitBatch(batchId, action, revision, windowName, note)
    toast({ title: result.message, status: result.ok ? 'success' : result.blocking ? 'error' : 'warning', duration: 7000 })
  }

  return <Box p="6" pb="16">
    <Box mb="5"><Text fontSize="xs" color="gray.600">冻结依据 / 修订号裁决 / 冲突草稿 / 恢复与回执</Text><Text fontSize="xl" fontWeight="700" mt="1">复核队列与发布批次</Text></Box>
    <Tabs colorScheme="teal">
      <TabList>
        <Tab>复核中 {reviewBatches.length > 0 && <Badge ml="2" colorScheme="orange">{reviewBatches.length}</Badge>}</Tab>
        <Tab>已失效 {invalidBatches.length > 0 && <Badge ml="2" colorScheme="red">{invalidBatches.length}</Badge>}</Tab>
        <Tab>已批准快照 {approvedBatches.length > 0 && <Badge ml="2" colorScheme="green">{approvedBatches.length}</Badge>}</Tab>
        <Tab>冲突草稿 {pendingDrafts.length > 0 && <Badge ml="2" colorScheme="purple">{pendingDrafts.length}</Badge>}</Tab>
        <Tab>故障演练</Tab>
      </TabList>
      <TabPanels>
        <TabPanel px="0">
          {reviewBatches.length === 0 && <EmptyHint text="暂无复核中批次。请在主张工作台点击「提交编辑复核」冻结依据。" />}
          {reviewBatches.map((batch) => <BatchReviewCard key={batch.id} batch={batch} onSubmit={submit} />)}
        </TabPanel>
        <TabPanel px="0">
          {invalidBatches.length === 0 && <EmptyHint text="暂无因证据版本、结论或疑点变化而失效的批次。" />}
          {invalidBatches.map((batch) => <InvalidBatchCard key={batch.id} batch={batch} />)}
        </TabPanel>
        <TabPanel px="0">
          {approvedBatches.length === 0 && <EmptyHint text="暂无已批准批次。批准后快照保留，依据再变化会标注必须复议。" />}
          {approvedBatches.map((batch) => <ApprovedBatchCard key={batch.id} batch={batch} onSubmit={submit} />)}
        </TabPanel>
        <TabPanel px="0">
          {state.drafts.length === 0 && <EmptyHint text="暂无冲突草稿。两窗口持同一修订号先后提交时，后到动作会在此留下差异。" />}
          {state.drafts.map((draft) => <DraftCard key={draft.id} draft={draft} />)}
        </TabPanel>
        <TabPanel px="0"><DrillPanel onNotice={(message, status) => toast({ title: message, status })} /></TabPanel>
      </TabPanels>
    </Tabs>
  </Box>
}

function EmptyHint({ text }: { text: string }) {
  return <Box bg="white" borderWidth="1px" borderStyle="dashed" p="6"><Text fontSize="sm" color="gray.500">{text}</Text></Box>
}

/* ---------------- 复核中：只按冻结依据审阅 + 双窗口提交 ---------------- */

function BatchReviewCard({ batch, onSubmit }: { batch: PublishedBatch; onSubmit: (batchId: string, action: '发布' | '撤回', revision: number, windowName: string, note: string) => void }) {
  const claim = useClaimStore((s) => s.claims.find((item) => item.id === batch.claimId))
  const [note, setNote] = useState('')
  const blocking = useMemo(() => preflightBasis(batch.basis), [batch])
  if (!claim) return null
  const drifted = diffLive(batch, claim)
  return <Box bg="white" borderWidth="1px" p="4" mb="4">
    <Flex justify="space-between" align="flex-start">
      <Box>
        <HStack mb="1"><Badge colorScheme="orange">{batch.status}</Badge><Text fontFamily="mono" fontSize="xs">{batch.id}</Text><Tag size="sm" colorScheme="teal">批次修订号 r{batch.revision}</Tag></HStack>
        <Text fontWeight="700">{claim.title}</Text>
        <Text fontSize="xs" color="gray.500" mt="1">冻结于 {batch.basis.frozenAt.replace('T', ' ').slice(0, 16)} · {batch.basis.frozenBy} 冻结 · 复核仅依据该快照，不读工作区实时数据</Text>
      </Box>
      <Box textAlign="right"><Text fontSize="xs" color="gray.500">主张实时修订号</Text><Tag colorScheme={drifted.length ? 'red' : 'green'}>r{claim.revision}</Tag>{drifted.length > 0 && <Text fontSize="xs" color="red.600" mt="1">工作区已偏离 {drifted.length} 项（复核仍按冻结依据）</Text>}</Box>
    </Flex>

    <Box mt="3" borderWidth="1px" p="3" bg="gray.50">
      <Text fontSize="sm" fontWeight="700" mb="2">冻结依据（结论 / 来源 / 相反证据）</Text>
      {batch.basis.facts.map((fact) => <Grid key={fact.factId} templateColumns="120px 1fr 1fr 1fr" gap="2" fontSize="xs" mb="2" alignItems="start">
        <Box><Text color="gray.500">{fact.factId}</Text><Badge colorScheme={impactConclusion(fact.conclusion)}>{fact.conclusion}</Badge></Box>
        <Box><Text fontWeight="600">{fact.text}</Text><Text color="gray.500" mt="1">置信度 {fact.confidence}%{fact.unresolved.length > 0 && ` · 疑点 ${fact.unresolved.length}`}</Text></Box>
        <Box>{fact.sources.map((source) => <Text key={source.id} color="green.700">✓ {source.title} V{source.version}</Text>)}{fact.sources.length === 0 && <Text color="gray.400">无支持证据</Text>}</Box>
        <Box>{fact.counterSources.map((source) => <Text key={source.id} color="red.700">✗ {source.title} V{source.version}</Text>)}{fact.counterSources.length === 0 && <Text color="gray.400">无相反证据</Text>}</Box>
      </Grid>)}
    </Box>

    {blocking.length > 0 && <Box bg="red.50" p="3" mt="3"><Text fontSize="sm" fontWeight="700" color="red.700">发布前校验（按冻结依据）未通过：</Text>{blocking.map((item) => <Text key={item} fontSize="xs" color="red.700">· {item}</Text>)}</Box>}

    <TwoWindowSubmit batch={batch} canPublish={blocking.length === 0} note={note} setNote={setNote} onSubmit={onSubmit} />
  </Box>
}

function TwoWindowSubmit({ batch, canPublish, note, setNote, onSubmit }: { batch: PublishedBatch; canPublish: boolean; note: string; setNote: (v: string) => void; onSubmit: (batchId: string, action: '发布' | '撤回', revision: number, windowName: string, note: string) => void }) {
  const [revA, setRevA] = useState(batch.revision)
  const [revB, setRevB] = useState(batch.revision)
  return <Box mt="3" borderTopWidth="1px" pt="3">
    <Text fontSize="xs" color="gray.500" mb="2">模拟两个编辑窗口同时打开该批次（各自持有打开时的修订号）。先到者推进修订号，后到者按修订号裁决：冲突只留草稿与差异，不覆盖先到结果。</Text>
    <Textarea size="sm" rows={2} mb="2" placeholder="发布批注（可选）" value={note} onChange={(event) => setNote(event.target.value)} />
    <Grid templateColumns="1fr 1fr" gap="3">
      <WindowBox title="窗口 A（编辑 宋卓）" rev={revA} setRev={setRevA} current={batch.revision} disabled={!canPublish} label={canPublish ? '按窗口A修订号批准发布' : '冻结依据未过校验'} onClick={() => onSubmit(batch.id, '发布', revA, '窗口A·宋卓', note)} />
      <WindowBox title="窗口 B（值班编辑 林澈）" rev={revB} setRev={setRevB} current={batch.revision} disabled={!canPublish} label={canPublish ? '按窗口B修订号批准发布' : '冻结依据未过校验'} onClick={() => onSubmit(batch.id, '发布', revB, '窗口B·林澈', note)} />
    </Grid>
  </Box>
}

function WindowBox({ title, rev, setRev, current, disabled, label, onClick }: { title: string; rev: number; setRev: (v: number) => void; current: number; disabled?: boolean; label: string; onClick: () => void }) {
  return <Box borderWidth="1px" p="3" bg={rev !== current ? 'red.50' : 'white'}>
    <Text fontSize="sm" fontWeight="700">{title}</Text>
    <Flex align="center" gap="2" mt="2"><Text fontSize="xs">持有修订号 r</Text><Input size="xs" w="70px" type="number" value={rev} onChange={(event) => setRev(Number(event.target.value))} /><Text fontSize="xs" color="gray.500">批次当前 r{current}{rev !== current && ' · 提交必冲突'}</Text></Flex>
    <Button size="sm" mt="2" colorScheme="teal" isDisabled={disabled} onClick={onClick}>{label}</Button>
  </Box>
}

/* ---------------- 已失效批次 ---------------- */

function InvalidBatchCard({ batch }: { batch: PublishedBatch }) {
  const claim = useClaimStore((s) => s.claims.find((item) => item.id === batch.claimId))
  const enterReview = useClaimStore((s) => s.enterReview)
  const toast = useToast()
  if (!claim) return null
  return <Box bg="white" borderWidth="1px" p="4" mb="4" borderLeftWidth="4px" borderLeftColor="red.500">
    <Flex justify="space-between"><Box><HStack><Badge colorScheme="red">已失效</Badge><Text fontFamily="mono" fontSize="xs">{batch.id}</Text><Tag size="sm">r{batch.revision}（停留在冻结时修订号）</Tag></HStack><Text fontWeight="700" mt="1">{claim.title}</Text><Text fontSize="xs" color="gray.500">失效时间 {batch.invalidatedAt?.replace('T', ' ').slice(0, 16)} · 触发：{batch.invalidatedBy}</Text></Box><Button size="sm" colorScheme="teal" onClick={() => { const result = enterReview(claim.id, '依据已变化，重新冻结后复核'); toast({ title: result.message, status: result.ok ? 'success' : 'error' }) }}>重新冻结并提交复核</Button></Flex>
    <ImpactTable impacts={batch.impact} />
  </Box>
}

/* ---------------- 已批准快照（发布/撤回 + 必须复议） ---------------- */

function ApprovedBatchCard({ batch, onSubmit }: { batch: PublishedBatch; onSubmit: (batchId: string, action: '发布' | '撤回', revision: number, windowName: string, note: string) => void }) {
  const claim = useClaimStore((s) => s.claims.find((item) => item.id === batch.claimId))
  const [rev, setRev] = useState(batch.revision)
  if (!claim) return null
  return <Box bg="white" borderWidth="1px" p="4" mb="4" borderLeftWidth="4px" borderLeftColor={batch.status === '已发布' ? 'green.500' : 'gray.400'}>
    <Flex justify="space-between">
      <Box><HStack><Badge colorScheme={batchStatusColor[batch.status]}>{batch.status}</Badge><Text fontFamily="mono" fontSize="xs">{batch.id}</Text><Tag size="sm" colorScheme="teal">r{batch.revision}</Tag>{batch.mustReconsider && <Badge colorScheme="purple">必须复议</Badge>}</HStack>
        <Text fontWeight="700" mt="1">{claim.title}</Text>
        <Text fontSize="xs" color="gray.500">{batch.approvedAt && `发布于 ${batch.approvedAt.replace('T', ' ').slice(0, 16)} · ${batch.approvedBy}`}{batch.withdrawnAt && ` · 撤回于 ${batch.withdrawnAt.replace('T', ' ').slice(0, 16)} · ${batch.withdrawnBy}`}</Text>
      </Box>
      {batch.status === '已发布' && <Flex align="center" gap="2" bg={rev !== batch.revision ? 'red.50' : 'gray.50'} p="2" borderWidth="1px"><Text fontSize="xs">窗口持有 r</Text><Input size="xs" w="70px" type="number" value={rev} onChange={(event) => setRev(Number(event.target.value))} /><Button size="sm" colorScheme="red" variant="outline" onClick={() => onSubmit(batch.id, '撤回', rev, '窗口A·宋卓', '发布后需撤回')}>提交撤回</Button></Flex>}
    </Flex>
    {batch.mustReconsider && <Box bg="purple.50" p="3" mt="3"><Text fontSize="sm" fontWeight="700" color="purple.700">快照保留但必须复议</Text><Text fontSize="xs" color="purple.700" mt="1">{batch.reconsiderNote}</Text><ImpactTable impacts={batch.impact} /></Box>}
    <Box mt="3"><Text fontSize="xs" color="gray.500" mb="1">批次历史</Text>{batch.history.map((entry, index) => <Text key={index} fontSize="xs">· r{entry.revision} {entry.action} · {entry.editor} · {entry.createdAt.replace('T', ' ').slice(0, 16)} · {entry.note}</Text>)}</Box>
    {batch.conflictDraftIds.length > 0 && <Text fontSize="xs" color="purple.600" mt="2">关联冲突草稿 {batch.conflictDraftIds.length} 份（见冲突草稿页）</Text>}
  </Box>
}

/* ---------------- 冲突草稿 ---------------- */

function DraftCard({ draft }: { draft: ConflictDraft }) {
  const resubmit = useClaimStore((s) => s.resubmitDraft)
  const discard = useClaimStore((s) => s.discardDraft)
  const batch = useClaimStore((s) => s.batches.find((item) => item.id === draft.batchId))
  const toast = useToast()
  const discarded = draft.resolution === '已丢弃'
  return <Box bg="white" borderWidth="1px" p="4" mb="4" opacity={discarded ? 0.55 : 1}>
    <Flex justify="space-between"><Box><HStack><Badge colorScheme={discarded ? 'gray' : 'purple'}>{draft.resolution}</Badge><Text fontFamily="mono" fontSize="xs">{draft.id}</Text><Tag size="sm">{draft.action}草稿</Tag><Text fontSize="xs" color="gray.500">回执 {draft.receiptId}</Text></HStack><Text fontSize="sm" mt="1">{draft.windowName} 持 r{draft.attemptedRevision} 对批次 {draft.batchId} 提交「{draft.action}」，批次当时已在 r{draft.currentRevision}</Text></Box></Flex>
    <Box bg="red.50" p="3" mt="2">{draft.diff.map((line, index) => <Text key={index} fontSize="xs" color="red.800">· {line}</Text>)}</Box>
    {!discarded && <Flex gap="2" mt="3"><Button size="sm" colorScheme="teal" variant="outline" onClick={() => { const result = resubmit(draft.id, ''); toast({ title: result.message, status: result.ok ? 'success' : 'warning', duration: 6000 }) }}>以批次当前 r{batch?.revision} 重新提交（旧草稿留痕后关闭）</Button><Button size="sm" variant="ghost" onClick={() => { discard(draft.id); toast({ title: '草稿已丢弃，差异保留在审计中', status: 'info' }) }}>丢弃草稿</Button></Flex>}
  </Box>
}

/* ---------------- 故障演练：写入失败恢复 + 回执重放 ---------------- */

function DrillPanel({ onNotice }: { onNotice: (message: string, status: 'success' | 'warning' | 'error' | 'info') => void }) {
  const state = useClaimStore()
  const publishable = state.batches.find((batch) => batch.status === '复核中')
  const receipts = state.receipts
  return <Flex direction="column" gap="4">
    <Box bg="white" borderWidth="1px" p="4">
      <Text fontWeight="700">写入失败 → 从上一完整批次恢复</Text>
      <Text fontSize="sm" color="gray.600" mt="1">开启后，下一次批准发布/撤回在落库前模拟写入失败：状态回滚到上一完整批次修订号并写入 pre-write 日志；下次打开页面（刷新）时启动恢复会读取该日志再次确认恢复点。</Text>
      <Flex align="center" gap="3" mt="3"><Switch isChecked={state.failNextWrite} onChange={(event) => state.setFailNextWrite(event.target.checked)} colorScheme="red" /><Text fontSize="sm">{state.failNextWrite ? '下一次批次提交将写入失败' : '正常写入'}</Text>{!publishable && <Text fontSize="xs" color="gray.500">（需要一个复核中批次才能演练）</Text>}</Flex>
    </Box>
    <Box bg="white" borderWidth="1px" p="4">
      <Text fontWeight="700">回执重放（不新增审计）</Text>
      <Text fontSize="sm" color="gray.600" mt="1">同一回执重复送达时，返回首次提交的原始结果并累加重放计数；审计事件数量不增加。</Text>
      {receipts.length === 0 && <Text fontSize="xs" color="gray.400" mt="2">尚无回执，请先完成一次批次提交或制造一次冲突。</Text>}
      {receipts.map((receipt) => {
        const before = state.audit.length
        return <Flex key={receipt.id} justify="space-between" align="center" borderWidth="1px" p="2" mt="2">
          <Box><HStack><Text fontFamily="mono" fontSize="xs">{receipt.id}</Text><Badge colorScheme={receipt.outcome === '已提交' ? 'green' : 'purple'}>{receipt.outcome}</Badge><Text fontSize="xs" color="gray.500">{receipt.action} · 依据 r{receipt.attemptedRevision} · 已重放 {receipt.replayCount} 次</Text></HStack></Box>
          <Button size="xs" variant="outline" onClick={() => { const result = state.replayReceipt(receipt.id); onNotice(`${result.message}｜审计条数 ${before} → ${useClaimStore.getState().audit.length}`, result.ok ? 'success' : 'info') }}>重放回执</Button>
        </Flex>
      })}
    </Box>
    <Box bg="white" borderWidth="1px" p="4">
      <Text fontWeight="700">恢复记录</Text>
      {state.recoveries.length === 0 && <Text fontSize="xs" color="gray.400" mt="2">暂无恢复事件。</Text>}
      {state.recoveries.map((record) => <Box key={record.id} bg="yellow.50" p="2" mt="2"><HStack><Badge colorScheme={record.trigger === '写入失败' ? 'red' : 'yellow'}>{record.trigger}</Badge><Text fontFamily="mono" fontSize="xs">{record.id}{record.walId && ` · WAL ${record.walId}`}</Text></HStack><Text fontSize="xs" mt="1">{record.detail}</Text><Text fontSize="xs" color="gray.500">恢复点：{record.restoredTo} · {record.at.replace('T', ' ').slice(0, 16)}</Text></Box>)}
    </Box>
  </Flex>
}

/* ---------------- 共用 ---------------- */

function ImpactTable({ impacts }: { impacts: PublishedBatch['impact'] }) {
  if (impacts.length === 0) return null
  return <Box mt="3" overflowX="auto"><Box minW="720px">{impacts.map((impact, index) => <Grid key={`${impact.factId}-${impact.kind}-${index}`} templateColumns="90px 110px 1fr 1fr" gap="2" borderBottomWidth="1px" py="1" fontSize="xs"><Text color="gray.500">{impact.factId}</Text><Badge colorScheme={impactKindColor[impact.kind]}>{impact.kind}</Badge><Text color="red.700">{impact.before}</Text><Text color="green.700">{impact.after}</Text></Grid>)}</Box></Box>
}

function diffLive(batch: PublishedBatch, claim: ReturnType<typeof useClaimStore.getState>['claims'][number]) {
  // 轻量偏离计数（完整差异在引擎层），这里直接复用批次最近 impact + 修订号比较
  if ((claim.revision ?? 1) === batch.basis.claimRevision) return []
  return batch.impact.length ? batch.impact : [{ factId: '-', text: '', kind: '事实变化' as const, before: `r${batch.basis.claimRevision}`, after: `r${claim.revision}` }]
}

function impactConclusion(conclusion: string): string {
  return conclusion === '已证实' ? 'green' : conclusion === '不实' ? 'red' : conclusion === '部分属实' ? 'yellow' : 'orange'
}
