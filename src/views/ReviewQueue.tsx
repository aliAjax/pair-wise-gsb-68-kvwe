import { Badge, Box, Button, Flex, HStack, Text, useToast } from '@chakra-ui/react'
import { preflightBasis } from '../services/batch'
import { useClaimStore } from '../store/useClaimStore'
import type { PublicationBatch } from '../types'

export function ReviewQueue() {
  const state = useClaimStore()
  const toast = useToast()
  // 复核队列以“复核中”批次为准；审阅依据是冻结快照，而非可能已变化的工作区
  const reviewingBatches = state.batches.filter((batch) => batch.status === '复核中')
  const claimOf = (batch: PublicationBatch) => state.claims.find((claim) => claim.id === batch.claimId)

  const approve = (batch: PublicationBatch) => {
    const result = state.decideBatch(batch.id, '发布', '编辑复核窗口', batch.batchRev)
    toast({ title: result.message, status: result.ok ? 'success' : 'warning', duration: 5000 })
  }

  return <Box p="6" pb="16">
    <Box mb="5"><Text fontSize="xs" color="gray.600">冻结结论 / 冻结来源 / 冻结相反证据 / 只按批次依据审阅</Text><Text fontSize="xl" fontWeight="700" mt="1">复核队列</Text></Box>
    <Flex direction="column" gap="3">
      {reviewingBatches.map((batch) => {
        const claim = claimOf(batch)
        if (!claim) return null
        const preflight = preflightBasis(batch.frozenBasis)
        const drifted = batch.drift.length > 0
        return <Box key={batch.id} bg="white" borderWidth="1px" borderColor={drifted ? 'orange.300' : undefined} p="4">
          <Flex justify="space-between">
            <Box><Text fontFamily="mono" fontSize="xs" color="gray.500">{claim.id} · 批次 {batch.id}</Text><Text fontWeight="700" mt="1">{claim.title}</Text></Box>
            <HStack><Badge colorScheme="blue">复核中</Badge><Badge variant="outline">冻结 R{batch.baseRev} / 当前 R{claim.rev ?? 0}</Badge></HStack>
          </Flex>

          <Box mt="4">
            <Text fontSize="sm" fontWeight="600">冻结依据 {batch.frozenBasis.length} 项事实（进入复核后不再随工作区变化）</Text>
            {batch.frozenBasis.map((fact) => <Box key={fact.factId} mt="2" p="2" bg="gray.50">
              <Flex justify="space-between"><Text fontSize="sm" fontWeight="600">{fact.factId} · {fact.text}</Text><Badge colorScheme={fact.conclusion === '已证实' ? 'green' : fact.conclusion === '不实' ? 'red' : 'orange'}>{fact.conclusion}</Badge></Flex>
              <Text fontSize="xs" color="gray.500" mt="1">置信度 {fact.confidence}% · 支持证据 {fact.sources.filter((source) => !source.counter).length} · 相反证据 {fact.sources.filter((source) => source.counter).length} · 疑点 {fact.unresolved.length}</Text>
              {fact.unresolved.map((item, index) => <Text key={index} fontSize="xs" color="red.600">疑点：{item}</Text>)}
            </Box>)}
          </Box>

          {drifted && <Box mt="3" bg="orange.50" p="2">
            <Text fontSize="xs" fontWeight="700" color="orange.800">工作区依据已变化，批次失效。受影响事实：{[...new Set(batch.drift.map((item) => item.factId))].join('、')}</Text>
            {batch.drift.map((item, index) => <Text key={index} fontSize="xs">{item.kind} · {item.factId}：{item.frozen} → {item.current}</Text>)}
          </Box>}

          {!preflight.allowed && !drifted && <Box mt="3" bg="red.50" p="2"><Text fontSize="xs" fontWeight="700" color="red.800">冻结依据未通过发布前校验</Text>{preflight.blocking.map((item, index) => <Text key={index} fontSize="xs" color="red.700">{item}</Text>)}</Box>}

          <Button mt="4" size="sm" colorScheme="teal" isDisabled={!preflight.allowed || drifted} onClick={() => approve(batch)}>
            {drifted ? '批次已失效，需重新冻结' : !preflight.allowed ? '冻结依据未通过校验' : '按冻结依据批准发布'}
          </Button>
        </Box>
      })}
      {reviewingBatches.length === 0 && <Box bg="white" borderWidth="1px" p="6"><Text color="gray.500" fontSize="sm">没有复核中的批次。在「发布批次」页将主张送入复核时会冻结结论、来源和相反证据。</Text></Box>}
    </Flex>
  </Box>
}
