// The installed bundle (Desktop: Plugins → Add plugin; CLI: `dsh plugin add`)
// must offer line-number editing by default, like the headless, eval and
// teacher entry points. Without the row the preset only mounts DSH's literal
// `edit`, so a gateway install would silently run a different edit mode.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  exports?: Record<string, string>
}
const lines = patch.split('\n')
const indentOf = (line: string) => line.length - line.trimStart().length

test('bundle: the RWKV preset mounts the line-edit plugin', () => {
  const preset = lines.findIndex(line => line.trim() === '- id: preset-rwkv')
  const row = lines.findIndex(line => line.trim() === '- id: rwkv-edit-lines')
  assert.ok(preset >= 0, 'cordis.patch.yml declares the RWKV preset')
  assert.ok(row > preset, 'cordis.patch.yml mounts rwkv-edit-lines after the preset starts')
  assert.ok(indentOf(lines[row]!) > indentOf(lines[preset]!), 'rwkv-edit-lines is inside the preset, not at the profile root')
  assert.equal(lines[row + 1]?.trim(), 'name: dsh-rwkv-plugin/line-edit')
})

test('bundle: the line-edit entry the row names is exported by the package', () => {
  assert.equal(manifest.exports?.['./line-edit'], './lib/line-edit.js')
})
