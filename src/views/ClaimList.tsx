import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Badge, Box, Button, Flex, Grid, GridItem, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Select, Table, Tbody, Td, Text, Th, Thead, Tr, useDisclosure, FormControl, FormLabel, Textarea } from '@chakra-ui/react'
import { useClaimStore } from '../store/useClaimStore'
import { loadClaimSnapshot } from '../services/api'
import type { Claim } from '../types'

export function ClaimList() {
  const navigate = useNavigate()
  const state = useClaimStore()
  const { isFetching } = useQuery({ queryKey: ['claims'], queryFn: () => loadClaimSnapshot(state.claims), staleTime: 60000 })
  const { isOpen, onOpen, onClose } = useDisclosure()
  const [form, setForm] = useState({ title: '', summary: '', reporter: '沈言', priority: '中' as Claim['priority'] })
  const rows = useMemo(() => state.claims.filter((item) => {
    const text = `${item.id} ${item.title} ${item.summary} ${item.reporter} ${item.editor}`.toLowerCase()
    return (!state.keyword || text.includes(state.keyword.toLowerCase())) && (state.status === '全部' || item.status === state.status)
  }), [state.claims, state.keyword, state.status])
  const create = () => {
    if (!form.title.trim()) return
    const claim = state.addClaim(form)
    onClose()
    setForm({ title: '', summary: '', reporter: '沈言', priority: '中' })
    navigate(`/claims/${claim.id}`)
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="center" mb="5"><Box><Text fontSize="xs" color="gray.600">内容中心 / 事实核查</Text><Text fontSize="xl" fontWeight="700" mt="1">核查主张</Text></Box><Button colorScheme="teal" onClick={onOpen}>建立核查主张</Button></Flex>
    <Grid templateColumns="repeat(4,1fr)" bg="white" borderWidth="1px" mb="4">
      {[['核查中', state.claims.filter((item) => item.status === '核查中').length, '正在收集证据'], ['待编辑复核', state.claims.filter((item) => item.status === '待编辑复核').length, '存在未解决批注'], ['已发布', state.claims.filter((item) => item.status === '已发布').length, '正式报告已锁定'], ['证据记录', state.claims.flatMap((item) => item.facts.flatMap((fact) => [...fact.sources, ...fact.counterSources])).length, '含相反证据']].map(([label, value, note], index) => <GridItem key={String(label)} p="4" borderRightWidth={index === 3 ? 0 : '1px'}><Text fontSize="xs" color="gray.600">{label}</Text><Text fontSize="2xl" fontWeight="700" color="brand.700" my="1">{value}</Text><Text fontSize="xs" color="gray.500">{note}</Text></GridItem>)}
    </Grid>
    <Flex gap="3" mb="3" align="center"><Input maxW="420px" placeholder="搜索编号、主张、记者或编辑" value={state.keyword} onChange={(event) => state.setKeyword(event.target.value)} /><Select maxW="180px" value={state.status} onChange={(event) => state.setStatus(event.target.value as typeof state.status)}>{['全部', '核查中', '待编辑复核', '已发布', '已撤回'].map((value) => <option key={value}>{value}</option>)}</Select><Text fontSize="xs" color="gray.500">{isFetching ? '正在同步' : '本地档案已加载'}</Text></Flex>
    <Box bg="white" borderWidth="1px"><Table size="sm"><Thead><Tr><Th>编号</Th><Th>核查主张</Th><Th>事实项</Th><Th>优先级</Th><Th>状态</Th><Th>版本</Th><Th>更新</Th><Th /></Tr></Thead><Tbody>{rows.map((claim) => <Tr key={claim.id}><Td fontFamily="mono" fontSize="xs">{claim.id}</Td><Td><Text fontWeight="600">{claim.title}</Text><Text fontSize="xs" color="gray.500" noOfLines={1}>{claim.summary}</Text></Td><Td>{claim.facts.length}</Td><Td><Badge colorScheme={claim.priority === '高' ? 'red' : claim.priority === '中' ? 'orange' : 'gray'}>{claim.priority}</Badge></Td><Td><Badge colorScheme={claim.status === '已发布' ? 'green' : claim.status === '已撤回' ? 'red' : 'orange'}>{claim.status}</Badge></Td><Td>V{claim.version}</Td><Td fontSize="xs">{claim.updatedAt.replace('T', ' ').slice(0, 16)}</Td><Td><Button size="xs" variant="ghost" onClick={() => navigate(`/claims/${claim.id}`)}>打开</Button></Td></Tr>)}</Tbody></Table></Box>
    <Modal isOpen={isOpen} onClose={onClose}><ModalOverlay /><ModalContent><ModalHeader>建立核查主张</ModalHeader><ModalCloseButton /><ModalBody><FormControl mb="3"><FormLabel>主张标题</FormLabel><Input value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /></FormControl><FormControl mb="3"><FormLabel>待核查摘要</FormLabel><Textarea rows={4} value={form.summary} onChange={(event) => setForm({ ...form, summary: event.target.value })} /></FormControl><Flex gap="3"><FormControl><FormLabel>记者</FormLabel><Input value={form.reporter} onChange={(event) => setForm({ ...form, reporter: event.target.value })} /></FormControl><FormControl><FormLabel>优先级</FormLabel><Select value={form.priority} onChange={(event) => setForm({ ...form, priority: event.target.value as Claim['priority'] })}>{['低', '中', '高'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl></Flex></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={onClose}>取消</Button><Button colorScheme="teal" isDisabled={!form.title.trim()} onClick={create}>创建并拆分事实</Button></ModalFooter></ModalContent></Modal>
  </Box>
}
