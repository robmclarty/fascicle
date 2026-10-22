import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';

// The compiled run canvas. Lives at the repo root beside vitest.config.ts and
// tsdown.config.ts rather than inside src/viewer/app/, because the repo's
// ast-grep rules (no-default-export, function-comment-required, no-semicolons)
// apply to every src/**/*.ts and a vite config cannot satisfy them.
//
// Output goes to dist/viewer-app/, which scripts/build.mjs produces after
// tsdown and src/viewer/server.ts serves. Source maps are off: the bundle
// ships in the npm tarball under the 350KB budget scripts/build.mjs enforces,
// and a dev tool's stack traces are not worth doubling it.
//
// The base is relative, so index.html loads ./assets/ and the CSS reaches the
// fonts as ../fonts/. A host can then serve the canvas under a path of its
// own, such as /viewer/<id>/ behind a proxy, and every asset still resolves
// under that path, the way the app's api/ requests do.
export default defineConfig({
  root: fileURLToPath(new URL('./src/viewer/app', import.meta.url)),
  base: './',
  plugins: [solid()],
  build: {
    outDir: fileURLToPath(new URL('./dist/viewer-app', import.meta.url)),
    emptyOutDir: true,
    sourcemap: false,
    target: 'es2022',
    assetsInlineLimit: 0,
  },
});
