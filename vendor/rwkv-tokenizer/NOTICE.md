# rwkv-tokenizer (vendored)

Exact RWKV World token counts without a network install: the published npm
package `rwkv-tokenizer@0.3.3` (2025-07-08), copied verbatim.

- Source: https://github.com/cahya-wirawan/rwkv-tokenizer (npm tarball
  `https://registry.npmjs.org/rwkv-tokenizer/-/rwkv-tokenizer-0.3.3.tgz`)
- License: MIT OR Apache-2.0 (as declared in the package's `package.json`; the
  tarball ships no license file)
- Vocabulary: 65,530 entries, the RWKV World vocabulary (`rwkv_vocab_v20230424`)
  used by `rwkv-tokenizer-go`, the reference for every token count in this
  workbench. Verified identical on 442 real tool results and on the fixtures in
  `test/edit-budget.test.ts`.

`rwkv_tokenizer.js` is a wasm-bindgen (CommonJS) glue file and reads
`rwkv_tokenizer_bg.wasm` from its own directory at require time; both files
must stay together. Do not edit either file. Re-vendoring means replacing both
and re-running `scripts/tokenizer-parity.ts`.

SHA-256:

```
d3583b3b4abe520e1820d27e66db393676bd00eacffeb109face0ff0818cc86c  rwkv_tokenizer.js
956b97490bb811b47886b9ec32c4b4ba6ae2d4b5b915bce03c7a32a8f9853ae2  rwkv_tokenizer_bg.wasm
4feb9d0cfade4b614c27266fc625a9270e5d046e52e22683ca4ac010b05eb10e  rwkv_tokenizer.d.ts
```
