// Exact RWKV World token counts.
//
// One process-wide tokenizer over the vendored rwkv-tokenizer WASM (CJS glue,
// see vendor/rwkv-tokenizer/NOTICE.md). The vocabulary is the same one
// rwkv-tokenizer-go counts with, so budgets and every token number reported
// for training data / evaluations share one unit.
//
// The WASM is loaded lazily on the first count: 2.3 MB read plus instantiation,
// about 5 ms, once per process. Nothing here imports the DSH runtime, so the
// pipeline's teacher plugin can mount the same code.

import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

interface WorldTokenizer {
  encode(text: string): Uint16Array
  decode(ids: Uint16Array): string
  vocab_size(): number
}

let cached: WorldTokenizer | undefined

/**
 * The package root, one level above both `src/` (pipeline imports the source)
 * and `lib/index.js` (DSH loads the bundle), so `vendor/` resolves the same way
 * in both.
 */
function load(): WorldTokenizer {
  const require = createRequire(import.meta.url)
  const root = join(dirname(fileURLToPath(import.meta.url)), '..')
  const module = require(join(root, 'vendor/rwkv-tokenizer/rwkv_tokenizer.js')) as {
    WorldTokenizer: new () => WorldTokenizer
  }
  return new module.WorldTokenizer()
}

/** Exact number of RWKV World tokens `text` encodes to. */
export function countTokens(text: string): number {
  cached ??= load()
  return cached.encode(text).length
}

/** Vocabulary size of the vendored tokenizer (65,530 = rwkv_vocab_v20230424). */
export function vocabSize(): number {
  cached ??= load()
  return cached.vocab_size()
}
