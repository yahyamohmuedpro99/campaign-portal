import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup.ts'],
    testTimeout: 60_000,
    hookTimeout: 120_000,
    // The suite talks to one Postgres and signs in as real users; running files in
    // parallel would interleave those sessions.
    fileParallelism: false,
  },
});
