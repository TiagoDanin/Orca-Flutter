import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import activate from '../main.mjs'

const manifest = JSON.parse(readFileSync(new URL('../orca-plugin.json', import.meta.url), 'utf8'))

// Loads the worker against a fake Orca and returns what it registered.
async function load() {
  const commands = []
  const panels = []
  const hooks = []
  const orca = {
    log() {},
    commands: { register: (id) => commands.push(id) },
    panels: { handle: (name) => panels.push(name), post() {} },
    hooks: { on: (event) => hooks.push(event) },
    storage: { get: async () => null, set: async () => {} },
    settings: { get: async () => undefined },
    host: { call: async () => ({}) }
  }
  const realSetInterval = globalThis.setInterval
  globalThis.setInterval = () => ({}) // the poll loop would keep the test process alive
  try {
    await activate(orca)
  } finally {
    globalThis.setInterval = realSetInterval
  }
  return { commands, panels, hooks }
}

test('the worker registers exactly the commands the manifest declares', async () => {
  const { commands } = await load()
  const declared = manifest.contributes.commands.map((c) => c.id)
  assert.deepEqual([...commands].sort(), [...declared].sort())
})

test('keybindings and the status bar only name declared commands', () => {
  const declared = new Set(manifest.contributes.commands.map((c) => c.id))
  for (const k of manifest.contributes.keybindings) assert.ok(declared.has(k.command), k.command)
  for (const item of manifest.contributes.statusBarItems) if (item.command) assert.ok(declared.has(item.command), item.command)
})

test('chords are unique', () => {
  const keys = manifest.contributes.keybindings.map((k) => k.key)
  assert.equal(new Set(keys).size, keys.length)
})

test('the worker handles every hook the manifest declares', async () => {
  const { hooks } = await load()
  assert.deepEqual(hooks.sort(), manifest.contributes.hooks.map((h) => h.event).sort())
})

test('the panel only calls requests the worker handles', async () => {
  const { panels } = await load()
  const source = readFileSync(new URL('./panel.tsx', import.meta.url), 'utf8')
  const requested = [...source.matchAll(/plugin\.request\('([^']+)'/g)].map((m) => m[1])
  assert.ok(requested.length > 0)
  for (const name of new Set(requested)) assert.ok(panels.includes(name), name)
})

test('every action id the panel triggers exists in the manifest', () => {
  const source = readFileSync(new URL('./panel.tsx', import.meta.url), 'utf8')
  const declared = new Set(manifest.contributes.commands.map((c) => c.id.replace('flutter.', '')))
  const ids = [...source.matchAll(/<Action id="([^"]+)"/g)].map((m) => m[1])
  assert.ok(ids.length > 0)
  for (const id of ids) assert.ok(declared.has(id), id)
})
