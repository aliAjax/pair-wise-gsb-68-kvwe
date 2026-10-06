import { useState } from 'react'
import { Badge, Box, Button, Flex, Grid, GridItem, Input, Table, Tbody, Td, Text, Th, Thead, Tr } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'

export function AuditArchive() {
  const state = useClaimStore()
  const [keyword, setKeyword] = useState('')
  const rows = state.audit.filter((item) => `${item.claimId} ${item.action} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase()))
  const legacyCount = state.claims.filter((claim) => claim.revision === 1 && state.audit.some((entry) => entry.claimId === claim.id && entry.action === '旧数据基线化')).length
  const exportAll = () => {
    const payload = { generatedAt: new Date().toISOString(), claims: state.claims, batches: state.batches, drafts: state.drafts, receipts: state.receipts, recoveries: state.recoveries, versions: state.versions, audit: state.audit }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '事实核查档案与审计.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  const stats = [
    ['发布批次', state.batches.length, '含复核中/失效/已发布/已撤回'],
    ['已批准且需复议', state.batches.filter((item) => item.mustReconsider).length, '快照保留，等待复议'],
    ['冲突草稿', state.drafts.filter((item) => item.resolution === '待处理').length, '后到动作差异未覆盖先到结果'],
    ['回执', state.receipts.length, `累计重放 ${state.receipts.reduce((sum, item) => sum + item.replayCount, 0)} 次`],
    ['基线化旧数据', legacyCount, '无修订号历史数据已升级 @r1'],
    ['恢复事件', state.recoveries.length, '写入失败/启动恢复']
  ]
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="center" mb="5"><Box><Text fontSize="xs" color="gray.600">主张 / 冻结依据 / 批次快照 / 回执 / 恢复</Text><Text fontSize="xl" fontWeight="700" mt="1">核查档案与审计</Text></Box><Button colorScheme="teal" onClick={exportAll}>导出全部档案</Button></Flex>
    <Grid templateColumns="repeat(6,1fr)" bg="white" borderWidth="1px" mb="4">
      {stats.map(([label, value, note], index) => <GridItem key={String(label)} p="3" borderRightWidth={index === 5 ? 0 : '1px'}><Text fontSize="xs" color="gray.600">{label}</Text><Text fontSize="xl" fontWeight="700" color="brand.700" my="1">{value}</Text><Text fontSize="10px" color="gray.500">{note}</Text></GridItem>)}
    </Grid>

    <Box bg="white" borderWidth="1px" p="4" mb="4">
      <Text fontWeight="700" mb="3">批次档案（含冻结快照与修订链）</Text>
      {state.batches.length === 0 && <Text fontSize="xs" color="gray.400">尚无批次</Text>}
      {state.batches.map((batch) => {
        const claim = state.claims.find((item) => item.id === batch.claimId)
        return <Box key={batch.id} borderWidth="1px" p="3" mb="2">
          <Flex justify="space-between"><Text fontWeight="600" fontSize="sm">{batch.id} · {claim?.title ?? batch.claimId}</Text><Flex gap="2"><Badge colorScheme={batch.status === '已发布' ? 'green' : batch.status === '已失效' ? 'red' : batch.status === '已撤回' ? 'gray' : 'orange'}>{batch.status}</Badge>{batch.mustReconsider && <Badge colorScheme="purple">必须复议</Badge>}<Badge variant="outline">r{batch.revision}</Badge></Flex></Flex>
          <Text fontSize="xs" color="gray.500" mt="1">冻结 r{batch.basis.claimRevision}（{batch.basis.facts.length} 事实 / {batch.basis.facts.reduce((sum, fact) => sum + fact.sources.length + fact.counterSources.length, 0)} 证据）· 受影响事实 {batch.impact.length} · 草稿 {batch.conflictDraftIds.length}</Text>
          <Text fontSize="xs" mt="1" color="gray.600">{batch.history.map((entry) => `r${entry.revision} ${entry.action}`).join(' → ')}</Text>
        </Box>
      })}
    </Box>

    <Flex gap="3" mb="3"><Input maxW="460px" placeholder="搜索主张、动作、操作人或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Text alignSelf="center" fontSize="xs" color="gray.500">共{rows.length}条不可变审计事件（回执重放不新增）</Text></Flex>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>时间</Th><Th>主张</Th><Th>动作</Th><Th>操作人</Th><Th>说明</Th><Th>回执</Th></Tr></Thead><Tbody>{rows.map((item) => <Tr key={item.id}><Td fontSize="xs">{item.createdAt.replace('T', ' ').slice(0, 16)}</Td><Td fontFamily="mono" fontSize="xs">{item.claimId}</Td><Td><Badge colorScheme={item.action.includes('撤下') || item.action.includes('失效') ? 'red' : item.action.includes('发布') || item.action.includes('基线') ? 'green' : item.action.includes('冲突') ? 'purple' : 'blue'}>{item.action}</Badge></Td><Td>{item.operator}</Td><Td fontSize="sm">{item.detail}</Td><Td fontFamily="mono" fontSize="10px">{item.receiptId ?? '—'}</Td></Tr>)}</Tbody></Table></Box>
    <Box mt="5" bg="white" borderWidth="1px" p="4"><Text fontWeight="700">批次与版本原则</Text><Text fontSize="sm" color="gray.600" mt="2">进入复核即冻结结论、来源与相反证据，复核只按这份依据；证据版本、结论或疑点变化后未批准批次失效并列明受影响事实，已批准批次保留快照但标注必须复议。两窗口并发时后到动作按批次修订号裁决，冲突留草稿与差异、不覆盖先到结果。旧数据无修订号时迁移为 @r1 可追溯基线；写入失败从上一完整批次恢复；重放回执不新增审计。</Text></Box>
  </Box>
}
