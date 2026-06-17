import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Only the real Neon Equalizer test suite. aqua_temp/ is a separate
    // (legacy AQUA) checkout with its own Jest-based tests.
    include: ['tests/**/*.test.js'],
    exclude: ['aqua_temp/**', 'node_modules/**', 'dist/**', 'release/**'],
    environment: 'node',
  },
});
