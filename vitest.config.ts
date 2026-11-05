import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Deployment suites require an explicit opt-in AND explicit exported fixtures.
    exclude: process.env.DSH_SWARM_LIVE_TESTS === '1' ? [] : ['tests/*-live.test.ts'],
    // Every fixture cleans only its exact owned directory; no global prefix sweep.
    globalSetup: ['tests/global-setup.ts'],
  },
})
