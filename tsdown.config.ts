import { defineConfig } from 'tsdown';

// Deviations from spec §3.3, narrowly scoped:
//   - `dts: { eager: true }` (vs. `dts: true`): required to work around a
//     rolldown-plugin-dts bug that fails to resolve transitively re-exported
//     engine types (e.g. AliasTable) through the umbrella. Eager mode
//     compiles declarations via tsc first. Semantically equivalent to
//     `dts: true` — both emit ./dist/index.d.ts.
//   - `fixedExtension: false`: required so ESM output lands as `index.js`
//     (not `index.mjs`). The root package.json `exports` map references
//     `./dist/index.js`, which criterion 18 mandates. Default would be
//     `.mjs` because platform=node implies fixedExtension=true.
export default defineConfig({
  entry: ['./packages/fascicle/src/index.ts'],
  outDir: './dist',
  format: ['esm'],
  dts: { eager: true },
  sourcemap: true,
  clean: true,
  target: 'node24',
  platform: 'node',
  fixedExtension: false,
  noExternal: [/^@repo\//],
  external: ['ai', 'zod', /^@ai-sdk\//, 'ai-sdk-ollama', '@openrouter/ai-sdk-provider'],
});
