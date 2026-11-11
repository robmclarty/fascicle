import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/** Modules that siblings reach through a `#<module>` alias, mirroring `package.json` `imports`. */
const INTERNAL_MODULES = [
  'core',
  'engine',
  'composites',
  'adapters',
  'viewer',
  'agents',
  'stdio',
  'acp',
  'mcp',
  'ui',
  'policy',
  'process',
  'schema',
  'testing',
  'web',
];

/** Modules published as `fascicle/<module>` subpaths, mirroring `package.json` `exports`. */
const PUBLISHED_MODULES = ['acp', 'adapters', 'mcp', 'otel', 'stdio', 'ui', 'viewer', 'agents', 'testing', 'web'];

/**
 * Resolve a path beside this config to an absolute file path.
 */
function source(path: string): string {
  return fileURLToPath(new URL(path, import.meta.url));
}

export default defineConfig({
  resolve: {
    alias: [
      ...INTERNAL_MODULES.map((name) => ({ find: new RegExp(`^#${name}$`), replacement: source(`./src/${name}/index.ts`) })),
      // Published surface (examples + doc snippets import these names).
      ...PUBLISHED_MODULES.map((name) => ({ find: new RegExp(`^fascicle/${name}$`), replacement: source(`./src/${name}/index.ts`) })),
      { find: /^fascicle$/, replacement: source('./src/index.ts') },
    ],
  },
  test: {
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      // The examples are demo code, but their tests are stub-engine driven and
      // hit no network, so they run in the default suite: an example that no
      // longer matches the library is a docs bug that ships. Every example app
      // colocates tests in `__tests__/`, so these two globs cover all of them
      // and a new app is picked up without editing this list.
      'examples/*/src/**/__tests__/**/*.{test,spec}.ts',
      'examples/agents/**/__tests__/**/*.{test,spec}.ts',
    ],
    pool: 'forks',
    // A worker thread that the source starts (fascicle/acp's search worker)
    // loads outside vite's module runner, so Node resolves its imports, and
    // Node strips types without mapping the sources' `.js` specifiers to
    // their `.ts` files. Each test worker, Stryker's included, registers the
    // resolver the spawn harnesses use, and the threads it starts inherit it.
    execArgv: ['--import', fileURLToPath(new URL('./test/support/register-ts-resolver.mjs', import.meta.url))],
    // Off inside Stryker's workers. Its sandbox links node_modules, so all of
    // them share vitest's module cache there, and vitest wipes that cache when
    // the lockfile changes: the first mutation run after a dependency change
    // had every worker deleting the same directory at once (ENOTEMPTY).
    fsModuleCache: process.env['STRYKER_MUTATOR_WORKER'] === undefined,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.d.ts',
        // Cross-cutting test dirs (harnesses, fixtures, integration) are not
        // module source; keep coverage scoped to real implementation files.
        'src/**/test/**',
        'src/**/__tests__/**',
      ],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: '.check/coverage',
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
