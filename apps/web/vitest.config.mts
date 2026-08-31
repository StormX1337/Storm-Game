import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
      // The UI package ships TypeScript source, the same way Next consumes it.
      '@storm/ui': path.resolve(import.meta.dirname, '../../packages/ui/src'),
      '@storm/types': path.resolve(import.meta.dirname, '../../packages/types/src'),
    },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    css: false,
  },
});
