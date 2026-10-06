import { useMemo, useState } from 'react'
import { Badge, Box, Button, Flex, Input, Table, Tbody, Td, Text, Th, Thead, Tr } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'

const auditColor = (action: string) => {
  if (action.includes('冲突')) return 'purple'
  if (action.includes('相反') || action.includes('撤')) return 'red'
  if (action.includes('发布') || action.includes('批准')) return 'green'
  if (action.includes('失效') || action.includes('改版')) return 'orange'
  if (action.includes('恢复') || action.includes('基线') || action.includes('冻结')) return 'blue'
  return 'gray'
}

export function AuditArchive() {
  const state = useClaimStore()
  const [keyword, setKeyword] = useState('')
  const rows = useMemo(() => state.audit.filter((item) => `${item.claimId} ${item.action} ${item.operator} ${item.detail}`.toLowerCase().includes(keyword.toLowerCase())), [state.audit, keyword])
  const exportAll = () => {
    const payload = { generatedAt: new Date().toISOString(), claims: state.claims, batches: state.batches, receipts: state.receipts, versions: state.versions, audit: state.audit }
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = '事实核查批次档案与审计.json'; anchor.click(); URL.revokeObjectURL(url)
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="center" mb="5"><Box><Text fontSize="xs" color="gray.600">冻结批次 / 漂移失效 / 必须复议 / 冲突草稿 / 写入恢复 / 回执重放</Text><Text fontSize="xl" fontWeight="700" mt="1">核查档案与审计</Text></Box><Button colorScheme="teal" onClick={exportAll}>导出全部档案（含批次快照与回执）</Button></Flex>
    <Flex gap="3" mb="3"><Input maxW="460px" placeholder="搜索主张、动作、操作人或说明" value={keyword} onChange={(event) => setKeyword(event.target.value)} /><Text alignSelf="center" fontSize="xs" color="gray.500">共{rows.length}条审计事件；回执重放不新增审计</Text></Flex>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>时间</Th><Th>主张</Th><Th>动作</Th><Th>操作人</Th><Th>说明</Th></Tr></Thead><Tbody>{rows.map((item) => <Tr key={item.id}><Td fontSize="xs">{item.createdAt.replace('T', ' ').slice(0, 16)}</Td><Td fontFamily="mono" fontSize="xs">{item.claimId}</Td><Td><Badge colorScheme={auditColor(item.action)}>{item.action}</Badge></Td><Td>{item.operator}</Td><Td fontSize="sm">{item.detail}{item.receiptId && <Text as="span" fontSize="xs" color="gray.400">（回执 {item.receiptId.slice(0, 32)}…）</Text>}</Td></Tr>)}</Tbody></Table></Box>
    <Box mt="5" bg="white" borderWidth="1px" p="4">
      <Text fontWeight="700">发布批次留档原则</Text>
      <Text fontSize="sm" color="gray.600" mt="2">进入复核即冻结结论、来源和相反证据，复核只按该依据审阅。证据版本、结论或疑点变化后：未批准批次失效并列明受影响事实；已批准批次保留快照并标注必须复议。双窗口同时发布/撤回时按批次修订号裁决，后到动作保留冲突草稿与差异，不覆盖先到结果。旧数据无修订号时升级为 R0 可追溯基线；写入失败从上一完整批次恢复；回执重放幂等、不新增审计。</Text>
    </Box>
  </Box>
}
