import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
// Notion-style fonts (self-hosted, no network at runtime) + slash/bubble popups.
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/jetbrains-mono/400.css'
import 'tippy.js/dist/tippy.css'
import './index.css'
import { WhiteboardApp } from './components/WhiteboardApp'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WhiteboardApp />
  </StrictMode>
)
