import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { WhiteboardApp } from './components/WhiteboardApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WhiteboardApp />
  </StrictMode>
)
