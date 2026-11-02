import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // node:sqlite prints an ExperimentalWarning on import; harmless.
  },
});
