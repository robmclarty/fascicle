import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig } from 'vitest/config'

const HERE = dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  test: {
    root: HERE,
    include: ['tests/**/*.{test,spec}.ts'],
    pool: 'forks',
    reporters: ['default'],
  },
})
