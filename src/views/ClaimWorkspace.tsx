import { useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import { Badge, Box, Button, Divider, Flex, FormControl, FormLabel, Grid, HStack, Input, Modal, ModalBody, ModalCloseButton, ModalContent, ModalFooter, ModalHeader, ModalOverlay, Select, Tab, TabList, TabPanel, TabPanels, Tabs, Text, Textarea, useDisclosure, useToast } from '@chakra-ui/react'
import { EvidenceGraph } from '../components/EvidenceGraph'
import { conclusionColor, useClaimStore } from '../store/useClaimStore'
import type { ClaimFact, EvidenceKind, FactConclusion, SourceRecord } from '../types'

export function ClaimWorkspace() {
  const { id } = useParams()
  const toast = useToast()
  const state = useClaimStore()
  const claim = state.claims.find((item) => item.id === id)
  const [selectedFactId, setSelectedFactId] = useState(claim?.facts[0]?.id ?? '')
  const selectedFact = claim?.facts.find((item) => item.id === selectedFactId) ?? claim?.facts[0]
  const [factText, setFactText] = useState('')
  const sourceModal = useDisclosure()
  const versionModal = useDisclosure()
  const [sourceForm, setSourceForm] = useState<Omit<SourceRecord, 'id' | 'capturedAt' | 'version'>>({ title: '', url: '', publisher: '', publishedAt: '2026-09-29', kind: '原始证据', chainOfCustody: '', contentHash: '' })
  const [counterSource, setCounterSource] = useState(false)
  const [transitionNote, setTransitionNote] = useState('')
  useEffect(() => { if (!selectedFactId && claim?.facts[0]) setSelectedFactId(claim.facts[0].id) }, [selectedFactId, claim])
  if (!claim) return <Box p="10">未找到核查主张</Box>
  const setFact = (patch: Partial<ClaimFact>) => { if (selectedFact) state.updateFact(claim.id, selectedFact.id, patch) }
  const addSource = () => {
    if (!selectedFact || !sourceForm.title || !sourceForm.url) return
    state.addSource(claim.id, selectedFact.id, sourceForm, counterSource)
    sourceModal.onClose()
    toast({ title: '证据已加入关系图', status: 'success' })
  }
  const exportArchive = () => {
    const versions = state.versions.filter((item) => item.claimId === claim.id)
    const audit = state.audit.filter((item) => item.claimId === claim.id)
    const batches = state.batches.filter((item) => item.claimId === claim.id)
    const blob = new Blob([JSON.stringify({ claim, versions, batches, audit }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `${claim.id}-核查档案.json`; anchor.click(); URL.revokeObjectURL(url)
  }
  const activeBatch = state.batches.find((batch) => batch.claimId === claim.id && (batch.status === '复核中' || batch.status === '已批准'))
  const submitReview = () => {
    const result = state.submitForReview(claim.id, '主窗口', transitionNote || '提交编辑复核并冻结发布批次依据')
    toast({ title: result.message, status: result.ok ? 'success' : 'error' })
    if (result.ok) versionModal.onClose()
  }
  const withdraw = () => {
    if (!activeBatch) return
    const result = state.decideBatch(activeBatch.id, '撤回', '主窗口', activeBatch.batchRev)
    toast({ title: result.message, status: result.ok ? 'success' : 'warning' })
  }
  return <Box p="6" pb="16">
    <Flex justify="space-between" align="flex-start" mb="4"><Box><Text fontSize="xs" color="gray.600">{claim.id} · {claim.reporter} / {claim.editor} · V{claim.version} · 修订号 R{claim.rev ?? 0}</Text><Text fontSize="xl" fontWeight="700" mt="1">{claim.title}</Text><Text color="gray.600" fontSize="sm" mt="2" maxW="760px">{claim.summary}</Text></Box><Flex gap="2"><Button variant="outline" onClick={exportArchive}>导出档案</Button><Button colorScheme="teal" onClick={versionModal.onOpen}>进入复核冻结</Button>{activeBatch?.status === '已批准' && <Button colorScheme="red" variant="outline" onClick={withdraw}>撤回已发布批次</Button>}</Flex></Flex>
    {activeBatch && <Box bg={activeBatch.mustReconsider ? 'yellow.50' : 'blue.50'} borderWidth="1px" borderColor={activeBatch.mustReconsider ? 'yellow.300' : 'blue.300'} p="3" mb="3">
      <Text fontSize="sm" fontWeight="700">{activeBatch.status === '复核中' ? '批次复核中：复核窗口只审阅冻结依据' : '批次已批准：发布快照已锁定'}{activeBatch.mustReconsider ? '；依据已变化，必须复议（快照保留）' : ''}</Text>
      <Text fontSize="xs" color="gray.600" mt="1">批次 {activeBatch.id} · 冻结 R{activeBatch.baseRev} · 批次 R{activeBatch.batchRev}{activeBatch.drift.length > 0 ? ` · 受影响事实 ${[...new Set(activeBatch.drift.map((item) => item.factId))].join('、')}` : ''}</Text>
    </Box>}
    <EvidenceGraph facts={claim.facts} />
    <Grid mt="4" templateColumns="320px 1fr" gap="4" alignItems="start">
      <Box bg="white" borderWidth="1px" p="3">
        <Flex justify="space-between" align="center" mb="3"><Text fontWeight="700">可验证事实树</Text><Badge>{claim.facts.length}</Badge></Flex>
        {claim.facts.map((fact) => <Box key={fact.id} as="button" textAlign="left" w="100%" p="3" mb="2" borderWidth="1px" borderColor={fact.id === selectedFact?.id ? 'teal.600' : 'gray.200'} bg={fact.id === selectedFact?.id ? 'teal.50' : 'white'} onClick={() => setSelectedFactId(fact.id)}><Flex justify="space-between"><Text fontSize="xs" color="gray.500">{fact.id}</Text><Badge colorScheme={conclusionColor[fact.conclusion]}>{fact.conclusion}</Badge></Flex><Text fontSize="sm" mt="2" fontWeight="600">{fact.text}</Text><Text fontSize="xs" color="gray.500" mt="2">置信度 {fact.confidence}% · 疑点 {fact.unresolved.length}</Text></Box>)}
        <Flex mt="3" gap="2"><Input size="sm" placeholder="拆出新的可验证事实" value={factText} onChange={(event) => setFactText(event.target.value)} /><Button size="sm" colorScheme="teal" onClick={() => { state.addFact(claim.id, factText); setFactText('') }}>添加</Button></Flex>
      </Box>
      {selectedFact && <Box bg="white" borderWidth="1px" p="4">
        <Flex justify="space-between" align="flex-start"><Box><Text fontSize="xs" color="gray.500">{selectedFact.id}</Text><Text fontWeight="700" mt="1">{selectedFact.text}</Text></Box><Badge colorScheme={conclusionColor[selectedFact.conclusion]}>{selectedFact.conclusion}</Badge></Flex>
        <Grid templateColumns="1fr 1fr 1fr" gap="3" mt="4">
          <FormControl><FormLabel fontSize="xs">事实结论</FormLabel><Select size="sm" value={selectedFact.conclusion} onChange={(event) => setFact({ conclusion: event.target.value as FactConclusion })}>{['已证实', '部分属实', '证据不足', '不实'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl>
          <FormControl><FormLabel fontSize="xs">置信程度 {selectedFact.confidence}%</FormLabel><Input size="sm" type="range" min="0" max="100" value={selectedFact.confidence} onChange={(event) => setFact({ confidence: Number(event.target.value) })} /></FormControl>
          <FormControl><FormLabel fontSize="xs">未解决疑点</FormLabel><Input size="sm" value={selectedFact.unresolved.join('；')} onChange={(event) => setFact({ unresolved: event.target.value ? event.target.value.split('；') : [] })} /></FormControl>
        </Grid>
        <Tabs mt="5" colorScheme="teal">
          <TabList><Tab>支持证据 {selectedFact.sources.length}</Tab><Tab>相反证据 {selectedFact.counterSources.length}</Tab><Tab>批注 {selectedFact.annotations.length}</Tab><Tab>来源时间线</Tab></TabList>
          <TabPanels>
            <TabPanel px="0"><EvidenceList sources={selectedFact.sources} claimId={claim.id} factId={selectedFact.id} onAdd={() => { setCounterSource(false); sourceModal.onOpen() }} /></TabPanel>
            <TabPanel px="0"><EvidenceList sources={selectedFact.counterSources} claimId={claim.id} factId={selectedFact.id} onAdd={() => { setCounterSource(true); sourceModal.onOpen() }} counter /></TabPanel>
            <TabPanel px="0"><AnnotationList fact={selectedFact} claimId={claim.id} /></TabPanel>
            <TabPanel px="0"><Box borderLeftWidth="2px" borderColor="gray.300" pl="4">{[...selectedFact.sources, ...selectedFact.counterSources].sort((a, b) => a.publishedAt.localeCompare(b.publishedAt)).map((source) => <Box key={source.id} mb="4"><Text fontSize="xs" color="gray.500">{source.publishedAt} · {source.kind}</Text><Text fontWeight="600" mt="1">{source.title}</Text><Text fontSize="sm" color="gray.600">{source.publisher} · 留档 {source.capturedAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}</Box></TabPanel>
          </TabPanels>
        </Tabs>
      </Box>}
    </Grid>
    <Modal isOpen={sourceModal.isOpen} onClose={sourceModal.onClose} size="xl"><ModalOverlay /><ModalContent><ModalHeader>{counterSource ? '关联相反证据' : '关联支持证据'}</ModalHeader><ModalCloseButton /><ModalBody><Grid templateColumns="1fr 1fr" gap="3"><FormControl><FormLabel>来源标题</FormLabel><Input value={sourceForm.title} onChange={(event) => setSourceForm({ ...sourceForm, title: event.target.value })} /></FormControl><FormControl><FormLabel>公开地址</FormLabel><Input value={sourceForm.url} onChange={(event) => setSourceForm({ ...sourceForm, url: event.target.value })} /></FormControl><FormControl><FormLabel>发布机构</FormLabel><Input value={sourceForm.publisher} onChange={(event) => setSourceForm({ ...sourceForm, publisher: event.target.value })} /></FormControl><FormControl><FormLabel>证据类型</FormLabel><Select value={sourceForm.kind} onChange={(event) => setSourceForm({ ...sourceForm, kind: event.target.value as EvidenceKind })}>{['原始证据', '二次来源', '待证信息'].map((value) => <option key={value}>{value}</option>)}</Select></FormControl><FormControl><FormLabel>内容哈希</FormLabel><Input placeholder="sha256:..." value={sourceForm.contentHash} onChange={(event) => setSourceForm({ ...sourceForm, contentHash: event.target.value })} /></FormControl><FormControl><FormLabel>留档说明</FormLabel><Input value={sourceForm.chainOfCustody} onChange={(event) => setSourceForm({ ...sourceForm, chainOfCustody: event.target.value })} /></FormControl></Grid></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={sourceModal.onClose}>取消</Button><Button colorScheme="teal" isDisabled={!sourceForm.title || !sourceForm.url} onClick={addSource}>加入证据关系图</Button></ModalFooter></ModalContent></Modal>
    <Modal isOpen={versionModal.isOpen} onClose={versionModal.onClose}><ModalOverlay /><ModalContent><ModalHeader>进入复核并冻结发布依据</ModalHeader><ModalCloseButton /><ModalBody><FormControl mb="4"><FormLabel>冻结说明</FormLabel><Textarea rows={4} value={transitionNote} onChange={(event) => setTransitionNote(event.target.value)} /></FormControl><Text fontSize="xs" color="gray.500">进入复核时冻结全部事实的结论、来源与相反证据；之后复核只按这份依据审阅。发布/撤回裁决在「发布批次」页按批次修订号进行。</Text></ModalBody><ModalFooter><Button variant="ghost" mr="3" onClick={versionModal.onClose}>取消</Button><Button colorScheme="teal" onClick={submitReview}>冻结并进入编辑复核</Button></ModalFooter></ModalContent></Modal>
  </Box>
}

function EvidenceList({ sources, claimId, factId, onAdd, counter = false }: { sources: SourceRecord[]; claimId: string; factId: string; onAdd: () => void; counter?: boolean }) {
  const changeEvidence = useClaimStore((state) => state.changeEvidence)
  return <Box><Flex justify="space-between" mb="3"><Text fontSize="sm" color="gray.600">{counter ? '相反证据与支持证据并列保留' : '按原始证据、二次来源、待证信息分类'}</Text><Button size="sm" colorScheme={counter ? 'red' : 'teal'} variant="outline" onClick={onAdd}>{counter ? '关联相反证据' : '关联支持证据'}</Button></Flex>{sources.map((source) => <Box key={source.id} borderWidth="1px" borderColor={source.retracted ? 'red.300' : undefined} p="3" mb="2" opacity={source.retracted ? 0.7 : 1}><Flex justify="space-between"><Text fontWeight="600">{source.title}{source.retracted && <Badge ml="2" colorScheme="red">已撤下</Badge>}</Text><Badge colorScheme={source.kind === '原始证据' ? 'green' : source.kind === '二次来源' ? 'orange' : 'gray'}>{source.kind}</Badge></Flex><Text fontSize="xs" color="gray.600" mt="2">{source.publisher} · {source.publishedAt} · V{source.version}</Text><Text fontFamily="mono" fontSize="xs" mt="2">{source.contentHash}</Text><Divider my="2" /><Flex justify="space-between" align="center"><Text fontSize="xs">{source.chainOfCustody}</Text><HStack><Button size="xs" variant="outline" onClick={() => changeEvidence(claimId, factId, source.id, { version: source.version + 1, contentHash: `sha256:改版${source.version + 1}-${Date.now() % 100000}` }, '另一窗口')}>模拟他窗改版 V{source.version + 1}</Button><Button size="xs" colorScheme="red" variant="ghost" isDisabled={source.retracted} onClick={() => changeEvidence(claimId, factId, source.id, { retracted: true }, '另一窗口')}>模拟他窗撤下</Button></HStack></Flex><Text fontSize="xs" color="blue.600" mt="1" wordBreak="break-all">{source.url}</Text></Box>)}</Box>
}

function AnnotationList({ fact, claimId }: { fact: ClaimFact; claimId: string }) {
  const addAnnotation = useClaimStore((state) => state.addAnnotation)
  const resolve = useClaimStore((state) => state.resolveAnnotation)
  const [text, setText] = useState('')
  return <Box><Flex gap="2" mb="3"><Input placeholder="添加事实核查批注" value={text} onChange={(event) => setText(event.target.value)} /><Button onClick={() => { addAnnotation(claimId, fact.id, { author: '陆衡', role: '事实核查员', content: text }); setText('') }}>添加</Button></Flex>{fact.annotations.map((item) => <Box key={item.id} borderLeftWidth="3px" borderColor={item.resolved ? 'green.400' : 'orange.400'} bg={item.resolved ? 'green.50' : 'orange.50'} p="3" mb="2"><Flex justify="space-between"><Text fontWeight="600" fontSize="sm">{item.role} {item.author}</Text><Button size="xs" variant="ghost" isDisabled={item.resolved} onClick={() => resolve(claimId, fact.id, item.id)}>{item.resolved ? '已解决' : '标记解决'}</Button></Flex><Text fontSize="sm" mt="2">{item.content}</Text><Text fontSize="xs" color="gray.500" mt="1">{item.createdAt.replace('T', ' ').slice(0, 16)}</Text></Box>)}</Box>
}
