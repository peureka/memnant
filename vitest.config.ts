import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup-isolation.ts'],
    include: ['tests/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 30000,
  },
});
