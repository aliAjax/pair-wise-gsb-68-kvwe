import React from 'react'
import ReactDOM from 'react-dom/client'
import { ChakraProvider, extendTheme } from '@chakra-ui/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { App } from './App'
import { bootstrapWorkbench } from './store/useClaimStore'
import './styles.css'

bootstrapWorkbench()

const theme = extendTheme({
  styles: { global: { body: { bg: '#eef2f0', color: '#1b2926', fontFamily: '"PingFang SC", "Microsoft YaHei", sans-serif' } } },
  colors: { brand: { 500: '#17695d', 600: '#11584e', 700: '#0d463f' } }
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={new QueryClient()}>
      <ChakraProvider theme={theme}><App /></ChakraProvider>
    </QueryClientProvider>
  </React.StrictMode>
)
