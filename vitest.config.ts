import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Removes the temp homes/storage roots this run creates (see the file's header).
    globalSetup: ['tests/global-setup.ts'],
  },
})
