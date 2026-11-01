import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Chime from './Chime'
import './page.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Chime />
  </StrictMode>,
)
