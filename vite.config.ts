import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  build: { sourcemap: 'hidden' },
  worker: { rollupOptions: { output: { sourcemap: 'hidden' } } },
  define: { 'import.meta.env.VITE_APP_BUILD': JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA ?? 'local') },
  test: { environment: 'jsdom', setupFiles: './src/testSetup.ts', css: true },
});
