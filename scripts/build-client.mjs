// Builds the browser half (src/client) into lib/client.js in the lazy-CJS
// factory format the DSH client module system loads:
//   window.__ModuleLoader__.load({ id, factory: (require) => { ...; return module.exports } })
// Only react is shared from the page's module table; everything else is inlined.
// esbuild is taken from the DSH checkout (DSH_ROOT, default ../deepseek-harness).

import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dshRoot = resolve(process.env.DSH_ROOT ?? join(root, '../deepseek-harness'))
const requireFromDsh = createRequire(join(dshRoot, 'package.json'))
let esbuild
try {
  esbuild = requireFromDsh('esbuild')
} catch {
  esbuild = createRequire(requireFromDsh.resolve('tsdown/package.json'))('esbuild')
}
const { name } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

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
