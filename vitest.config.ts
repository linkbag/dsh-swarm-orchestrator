import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Every fixture cleans only its exact owned directory; no global prefix sweep.
    globalSetup: ['tests/global-setup.ts'],
  },
})
