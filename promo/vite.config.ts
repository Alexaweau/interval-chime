import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Source lives in demo/. The built page is promo/index.html, which GitHub
// Pages serves at /interval-chime/promo/. Relative base so the assets resolve
// there and from a local file server.
export default defineConfig({
  root: 'demo',
  base: './',
  plugins: [react()],
  build: {
    outDir: '..',
    emptyOutDir: false,
    target: 'es2022',
    assetsDir: 'assets',
  },
  resolve: { dedupe: ['react', 'react-dom'] },
  server: { fs: { allow: ['..'] } },
})
