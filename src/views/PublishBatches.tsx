import { useMemo, useState } from 'react'
import { Badge, Box, Button, Divider, Flex, Grid, GridItem, HStack, Select, Table, Tbody, Td, Text, Th, Thead, Tr, useToast } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'
import { preflightBasis } from '../services/batch'
import type { BatchStatus, PublicationBatch } from '../types'

const statusColor: Record<BatchStatus, string> = {
  基线: 'gray',
  复核中: 'blue',
  已批准: 'green',
  已撤回: 'red',
  已失效: 'orange',
  冲突草稿: 'purple'
}

export function PublishBatches() {
  const state = useClaimStore()
  const toast = useToast()
  const [windowId, setWindowId] = useState('窗口A')
  const [revBump, setRevBump] = useState(true)
  const liveBatches = state.batches.filter((batch) => !batch.isBaseline)
  const claimById = useMemo(() => new Map(state.claims.map((claim) => [claim.id, claim])), [state.claims])

  const notify = (result: { ok: boolean; message: string }) => toast({ title: result.message, status: result.ok ? 'success' : 'warning', duration: 5000 })

  /** 模拟“另一窗口”在复核期间改版/撤下证据或修改结论，触发漂移 */
  const simulateOtherWindow = (batch: PublicationBatch) => {
    const claim = claimById.get(batch.claimId)
    if (!claim) return
    const basis = batch.frozenBasis[0]
    const fact = claim.facts.find((item) => item.id === basis.factId)
    if (!fact) return
    const source = [...fact.sources, ...fact.counterSources].find((item) => item.id === basis.sources[0]?.id)
    if (source) {
      const retract = !source.retracted && basis.sources.length % 2 === 1
      state.changeEvidence(claim.id, fact.id, source.id, retract
        ? { retracted: true }
        : { version: source.version + 1, contentHash: `sha256:${Math.random().toString(16).slice(2, 8)}...重放${Date.now() % 100000}` }, '另一窗口')
      notify({ ok: true, message: `另一窗口已${retract ? '撤下' : '改版'}证据：${source.title}` })
    } else {
      state.applyOtherWindowEdit(claim.id, fact.id, { conclusion: fact.conclusion === '已证实' ? '部分属实' : '已证实' }, '另一窗口')
      notify({ ok: true, message: '另一窗口已改动冻结事实的结论' })
    }
  }

  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="4">
      <Box><Text fontSize="xs" color="gray.600">复核冻结 / 漂移失效 / 双窗修订号裁决 / 完整快照恢复</Text><Text fontSize="xl" fontWeight="700" mt="1">发布批次</Text></Box>
      <HStack bg="white" borderWidth="1px" p="3" align="flex-end">
        <Box>
          <Text fontSize="xs" color="gray.500" mb="1">当前提交窗口</Text>
          <Select size="sm" value={windowId} onChange={(event) => setWindowId(event.target.value)}>
            <option>窗口A</option><option>窗口B</option>
          </Select>
        </Box>
        <Box>
          <Text fontSize="xs" color="gray.500" mb="1">决策携带修订号</Text>
          <Select size="sm" value={revBump ? 'snapshot' : 'stale'} onChange={(event) => setRevBump(event.target.value === 'snapshot')}>
            <option value="snapshot">进入复核时所见修订号（模拟并发同提）</option>
            <option value="stale">旧修订号（模拟后到/过期动作）</option>
          </Select>
        </Box>
        <Button size="sm" variant="outline" colorScheme={state.failNextCommit ? 'red' : 'gray'} onClick={() => { state.toggleFailNextCommit(!state.failNextCommit); notify({ ok: true, message: state.failNextCommit ? '已取消写入失败模拟' : '下一次发布/撤回写入将失败，并自动从上一完整批次恢复' }) }}>
          {state.failNextCommit ? '取消写入失败模拟' : '模拟下次写入失败'}
        </Button>
      </HStack>
    </Flex>

    <Grid templateColumns="repeat(4,1fr)" bg="white" borderWidth="1px" mb="4">
      {([
        ['复核中', liveBatches.filter((b) => b.status === '复核中').length, '结论已冻结'],
        ['已批准', liveBatches.filter((b) => b.status === '已批准').length, liveBatches.some((b) => b.mustReconsider) ? '存在必须复议批次' : '快照锁定'],
        ['已失效/草稿', liveBatches.filter((b) => b.status === '已失效' || b.status === '冲突草稿').length, '漂移失效或冲突留稿'],
        ['回执', state.receipts.length, '重放幂等']
      ] as Array<[string, number, string]>).map(([label, value, note]) => (
        <GridItem key={label} p="4"><Text fontSize="xs" color="gray.600">{label}</Text><Text fontSize="2xl" fontWeight="700" color="brand.700" my="1">{value}</Text><Text fontSize="xs" color="gray.500">{note}</Text></GridItem>
      ))}
    </Grid>

    <Flex direction="column" gap="4">
      {state.claims.map((claim) => {
        const batches = state.batches.filter((batch) => batch.claimId === claim.id).sort((a, b) => b.seq - a.seq || b.baseRev - a.baseRev)
        const active = batches.find((batch) => batch.status === '复核中' || batch.status === '已批准')
        return <Box key={claim.id} bg="white" borderWidth="1px" p="4">
          <Flex justify="space-between" align="center">
            <Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{claim.id} · 当前 R{claim.rev ?? 0} · {claim.status}</Text><Text fontWeight="700" mt="1">{claim.title}</Text></Box>
            <HStack>
              <Button size="sm" variant="outline" isDisabled={claim.status === '已发布' || (active?.status === '复核中')} onClick={() => {
                const result = state.submitForReview(claim.id, windowId, `${windowId}将主张提交复核，冻结发布依据`)
                notify(result)
              }}>进入复核并冻结</Button>
              {active && <Button size="sm" colorScheme="purple" variant="outline" onClick={() => simulateOtherWindow(active)}>模拟他窗改动证据/结论</Button>}
            </HStack>
          </Flex>

          {batches.length === 0 && <Text fontSize="sm" color="gray.500" mt="3">该主张为旧数据，已生成 R0 可追溯基线，等待进入复核。</Text>}

          {batches.map((batch) => {
            const preflight = preflightBasis(batch.frozenBasis)
            const expectedRev = revBump ? batch.baseRev : Math.max(0, batch.baseRev - 1)
            return <Box key={batch.id} mt="3" borderWidth="1px" borderColor={batch.isBaseline ? 'gray.200' : batch.status === '冲突草稿' ? 'purple.300' : 'gray.200'} bg={batch.isBaseline ? 'gray.50' : 'white'}>
              <Flex justify="space-between" align="center" px="3" py="2" bg={batch.mustReconsider ? 'yellow.50' : undefined}>
                <HStack>
                  <Badge colorScheme={statusColor[batch.status]}>{batch.status}</Badge>
                  <Text fontFamily="mono" fontSize="xs">{batch.id}{batch.isBaseline ? '（可追溯基线）' : ''}</Text>
                  {batch.mustReconsider && <Badge colorScheme="yellow">批准后依据变化 · 必须复议</Badge>}
                </HStack>
                <Text fontSize="xs" color="gray.500">冻结 R{batch.baseRev} → 批次 R{batch.batchRev} · 提交窗口 {batch.windowId} · {batch.frozenAt.replace('T', ' ').slice(5, 16)}</Text>
              </Flex>

              <Box px="3" py="2">
                <Text fontSize="xs" fontWeight="700" color="gray.600">冻结依据（复核只按这份）：{batch.frozenBasis.length} 项事实</Text>
                <Flex gap="2" mt="2" flexWrap="wrap">
                  {batch.frozenBasis.map((fact) => <Badge key={fact.factId} variant="outline" colorScheme={fact.conclusion === '不实' ? 'red' : fact.conclusion === '已证实' ? 'green' : 'orange'}>{fact.factId} {fact.conclusion} · 证据{fact.sources.length}（相反 {fact.sources.filter((s) => s.counter).length}）· 疑点{fact.unresolved.length}</Badge>)}
                </Flex>
                {!preflight.allowed && (batch.status === '复核中') && <Text fontSize="xs" color="red.600" mt="2">发布前校验：{preflight.blocking.join('；')}</Text>}

                {batch.drift.length > 0 && <Box mt="2" bg="orange.50" p="2">
                  <Text fontSize="xs" fontWeight="700" color="orange.800">受影响事实：{[...new Set(batch.drift.map((item) => item.factId))].join('、')}</Text>
                  {batch.drift.map((item, index) => <Text key={index} fontSize="xs" mt="1"><Badge size="sm" colorScheme="orange">{item.kind}</Badge> {item.factId}{item.sourceId ? ` · ${item.sourceId}` : ''}：冻结「{item.frozen}」→ 当前「{item.current}」</Text>)}
                </Box>}

                {batch.lateDraft && <Box mt="2" bg="purple.50" p="2">
                  <Text fontSize="xs" fontWeight="700" color="purple.900">后到动作草稿：{batch.lateDraft.windowId} 提交{batch.lateDraft.action}（基于 R{batch.lateDraft.expectedRev}，实际 R{batch.lateDraft.actualRev}），先到结果未被覆盖</Text>
                  {batch.lateDraft.differences.map((diff, index) => <Text key={index} fontSize="xs" mt="1">{diff.factId ? `${diff.factId} · ` : ''}{diff.label}：期望「{diff.expected}」/ 实际「{diff.actual}」</Text>)}
                </Box>}

                {batch.snapshotComplete && <Text fontSize="xs" color="gray.400" mt="2">完整快照：{batch.snapshotLabel}（可用于写入失败恢复）</Text>}
              </Box>

              {(batch.status === '复核中' || (batch.status === '已批准' && !batch.mustReconsider)) && <Flex px="3" pb="3" gap="2">
                <Button size="xs" colorScheme="teal" isDisabled={batch.status === '复核中' && !preflight.allowed} onClick={() => notify(state.decideBatch(batch.id, '发布', windowId, expectedRev))}>
                  {windowId} 发布{revBump ? `（按 R${batch.baseRev}）` : `（按过期 R${expectedRev}）`}
                </Button>
                <Button size="xs" colorScheme="red" variant="outline" isDisabled={batch.status === '复核中'} onClick={() => notify(state.decideBatch(batch.id, '撤回', windowId, revBump ? batch.batchRev : Math.max(0, batch.batchRev - 1)))}>{windowId} 撤回</Button>
                {batch.status === '已批准' && <Button size="xs" variant="ghost" onClick={() => notify(state.recoverFromLastComplete(claim.id))}>从本批次快照恢复</Button>}
              </Flex>}
              {batch.status === '已批准' && batch.mustReconsider && <Text px="3" pb="3" fontSize="xs" color="yellow.700">快照保留；重新发布需重新「进入复核并冻结」生成新批次。</Text>}
            </Box>
          })}
        </Box>
      })}
    </Flex>

    <Divider my="5" />
    <Text fontWeight="700" mb="3">动作回执（同键重放不新增审计）</Text>
    <Box bg="white" borderWidth="1px">
      <Table size="sm"><Thead><Tr><Th>时间</Th><Th>窗口</Th><Th>动作</Th><Th>结果</Th><Th>修订号</Th><Th>幂等键</Th><Th /></Tr></Thead><Tbody>
        {state.receipts.map((receipt) => <Tr key={receipt.key} opacity={receipt.replayed ? 0.65 : 1}>
          <Td fontSize="xs">{receipt.createdAt.replace('T', ' ').slice(5, 16)}</Td>
          <Td>{receipt.windowId}</Td>
          <Td>{receipt.action}</Td>
          <Td><Badge colorScheme={receipt.result === '冲突草稿' ? 'purple' : receipt.result === '已批准' ? 'green' : 'red'}>{receipt.result}</Badge>{receipt.replayed && <Badge ml="1" colorScheme="gray">已重放</Badge>}</Td>
          <Td>R{receipt.rev}</Td>
          <Td fontFamily="mono" fontSize="xs" wordBreak="break-all">{receipt.key}</Td>
          <Td><Button size="xs" variant="ghost" onClick={() => notify(state.replayReceipt(receipt.key, windowId))}>重放</Button></Td>
        </Tr>)}
        {state.receipts.length === 0 && <Tr><Td colSpan={7}><Text fontSize="sm" color="gray.500" p="3">尚无发布/撤回回执</Text></Td></Tr>}
      </Tbody></Table>
    </Box>
  </Box>
}
