import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    setupFiles: ['tests/setup-isolation.ts'],
    include: ['tests/**/*.test.ts'],
    // 30s: CLI-spawning tests cold-load the ~32MB embedding model per process;
    // under full-parallelism contention (the npm-test prepublish gate) they
    // routinely exceed 10s while being perfectly healthy.
    testTimeout: 30000,
    hookTimeout: 30000,
    // Most tests spawn CLI subprocesses that each cold-load the embedding
    // model; at full parallelism they saturate every core and vitest's
    // worker RPC starves ("Timeout calling onTaskUpdate" — exits 1 with all
    // tests passing, which killed npm publish's prepublish gate). Two workers
    // is deterministic-green and keeps the suite a valid publish gate.
    maxWorkers: 2,
  },
});
