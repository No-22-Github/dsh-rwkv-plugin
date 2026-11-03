// Builds both halves into lib/:
//   lib/index.js   Host half (ESM). Profile installs live under node_modules,
//                  where Node refuses to strip TypeScript, so DSH loads this
//                  JS. @deepseek-ai/* stay external: the profile resolves them
//                  to the running DSH's own copies.
//   lib/client.js  Browser half in the lazy-CJS factory format the DSH client
//                  module system loads:
//                  window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
//                  Only react is shared from the page's module table.
// esbuild comes from the DSH checkout (DSH_ROOT, default ../deepseek-harness)
// or from this package's own devDependencies.

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? join(root, '../deepseek-harness'))

function loadEsbuild() {
  for (const base of [join(root, 'package.json'), join(dshRoot, 'package.json')]) {
    const require = createRequire(base)
    try {
      return require('esbuild')
    } catch {
      try {
        return createRequire(require.resolve('tsdown/package.json'))('esbuild')
      } catch {
        // Try the next location.
      }
    }
  }
  throw new Error('esbuild not found: run `npm install` here, or set DSH_ROOT to a DSH checkout')
}

const esbuild = loadEsbuild()
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const only = process.argv[2]

if (only !== 'client') {
  await esbuild.build({
    entryPoints: [join(root, 'src/index.ts')],
    outfile: join(root, 'lib/index.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    sourcemap: 'linked',
    legalComments: 'none',
    logLevel: 'info',
  })
}

if (only !== 'host') {
  await esbuild.build({
    entryPoints: [join(root, 'src/client/index.tsx')],
    outfile: join(root, 'lib/client.js'),
    bundle: true,
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime', 'react-dom', '@deepseek-ai/cordis'],
    sourcemap: 'linked',
    legalComments: 'none',
    banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
    footer: { js: 'return module.exports; } });' },
    logLevel: 'info',
  })
}
