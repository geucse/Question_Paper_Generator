import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
// `npm run test:e2e` builds with `--mode e2e`: the app calls http://mock.local/api, which the Playwright suite
// (e2e/mock-ui.cjs) intercepts and answers, and the build goes to dist-e2e so it never replaces the real dist/.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  ...(mode === 'e2e' && {
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify('http://mock.local/api') },
    build: { outDir: 'dist-e2e', emptyOutDir: true },
  }),
}))
