import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    // elk.bundled.js is a CommonJS/UMD module — let Vite pre-bundle it so the
    // `import ELK from 'elkjs/lib/elk.bundled.js'` default export resolves.
    include: ['elkjs/lib/elk.bundled.js'],
  },
})
