import { defineConfig } from 'tsdown';

// Two non-default settings, narrowly scoped:
//   - `dts: { eager: true }` (vs. `dts: true`): works around a
//     rolldown-plugin-dts bug that fails to resolve transitively re-exported
//     engine types through the umbrella. Eager mode compiles declarations via
//     tsc first. Semantically equivalent to `dts: true`, since both emit
//     ./dist/index.d.ts. Under TypeScript 7 the plugin emits through tsgo,
//     which compiles every declaration up front anyway, so the flag only
//     matters to a build on TypeScript 6 or older.
//   - `fixedExtension: false`: makes ESM output land as `index.js` (not
//     `index.mjs`), which the root package.json `exports` map references.
//     The default would be `.mjs` because platform=node implies
//     fixedExtension=true.
export default defineConfig({
  entry: {
    index: './src/index.ts',
    acp: './src/acp/index.ts',
    adapters: './src/adapters/index.ts',
    agents: './src/agents/index.ts',
    mcp: './src/mcp/index.ts',
    otel: './src/otel/index.ts',
    stdio: './src/stdio/index.ts',
    testing: './src/testing/index.ts',
    ui: './src/ui/index.ts',
    viewer: './src/viewer/index.ts',
    // The fascicle-diagram bin's body. Not a package export: only the bin
    // shim that scripts/build.mjs writes imports it.
    diagram_bin: './src/diagram_bin.ts',
    // fascicle/acp's search worker. Not a package export either: the search
    // tool starts it by URL as dist/search_worker.js, beside the chunk that
    // holds the tool, since every chunk lands flat in dist/.
    search_worker: './src/acp/tools/search_worker.ts',
  },
  outDir: './dist',
  format: ['esm'],
  dts: { eager: true },
  sourcemap: true,
  clean: true,
  target: 'node24',
  platform: 'node',
  fixedExtension: false,
  external: [
    'ai',
    'zod',
    /^@ai-sdk\//,
    'ai-sdk-ollama',
    '@openrouter/ai-sdk-provider',
    /^@modelcontextprotocol\//,
    /^@agentclientprotocol\//,
  ],
});
