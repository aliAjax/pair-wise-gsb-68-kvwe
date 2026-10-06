import { BrowserRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom'
import { Badge, Box, Button, Flex, HStack, Text, VStack } from '@chakra-ui/react'
import { useClaimStore } from './store/useClaimStore'
import { ClaimList } from './views/ClaimList'
import { ClaimWorkspace } from './views/ClaimWorkspace'
import { ReviewQueue } from './views/ReviewQueue'
import { AuditArchive } from './views/AuditArchive'

function Shell() {
  const reset = useClaimStore((state) => state.reset)
  const review = useClaimStore((state) => state.batches.filter((item) => item.status === '复核中').length)
  return <Flex minH="100vh">
    <Box position="fixed" w="238px" inset="0 auto 0 0" bg="#17342f" color="white" px="4" py="5">
      <HStack borderBottomWidth="1px" borderColor="whiteAlpha.300" pb="5">
        <Box w="40px" h="40px" bg="#c79c39" color="#17342f" display="grid" placeItems="center" fontWeight="800" borderRadius="4px">核</Box>
        <Box><Text fontWeight="700" fontSize="sm">事实核查工作台</Text><Text color="whiteAlpha.600" fontSize="xs" mt="1">证据链与发布审阅</Text></Box>
      </HStack>
      <VStack align="stretch" mt="5" spacing="1">
        {[['/', '核查主张'], ['/reviews', '编辑复核'], ['/audit', '档案与审计']].map(([to, label]) => <NavLink key={to} to={to} end={to === '/'}><Flex px="3" py="2.5" borderRadius="4px" justify="space-between" fontSize="sm" color="whiteAlpha.700"><span>{label}</span>{label === '编辑复核' && review > 0 && <Badge colorScheme="red">{review}</Badge>}</Flex></NavLink>)}
      </VStack>
      <Box position="absolute" bottom="5" left="4" right="4" bg="blackAlpha.300" p="3">
        <Text fontSize="xs" color="whiteAlpha.600">当前角色</Text><Text fontSize="sm" mt="1">事实核查员 陆衡</Text><Text fontSize="xs" color="whiteAlpha.500" mt="1">争议证据不得被覆盖</Text>
      </Box>
    </Box>
    <Box ml="238px" flex="1" minW="0">
      <Routes>
        <Route path="/" element={<ClaimList />} />
        <Route path="/claims/:id" element={<ClaimWorkspace />} />
        <Route path="/reviews" element={<ReviewQueue />} />
        <Route path="/audit" element={<AuditArchive />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Button position="fixed" right="5" bottom="4" size="sm" variant="outline" onClick={reset}>恢复演示数据</Button>
    </Box>
  </Flex>
}

export function App() { return <BrowserRouter><Shell /></BrowserRouter> }
