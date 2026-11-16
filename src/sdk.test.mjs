import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findFvmRoot, flutterCommand } from './sdk.mjs'

function project(setup) {
  const root = mkdtempSync(join(tmpdir(), 'orca-flutter-'))
  setup(root)
  return root
}

test('plain project uses flutter', () => {
  const root = project(() => {})
  assert.equal(flutterCommand(root), 'flutter')
  rmSync(root, { recursive: true })
})

test('.fvmrc in the project uses fvm flutter', () => {
  const root = project((r) => writeFileSync(join(r, '.fvmrc'), '{"flutter":"stable"}'))
  assert.equal(flutterCommand(root), 'fvm flutter')
  rmSync(root, { recursive: true })
})

test('legacy .fvm/fvm_config.json is detected', () => {
  const root = project((r) => {
    mkdirSync(join(r, '.fvm'))
    writeFileSync(join(r, '.fvm', 'fvm_config.json'), '{}')
  })
  assert.equal(flutterCommand(root), 'fvm flutter')
  rmSync(root, { recursive: true })
})

test('a monorepo package inherits the root pin', () => {
  const root = project((r) => {
    writeFileSync(join(r, '.fvmrc'), '{}')
    mkdirSync(join(r, 'packages', 'shared'), { recursive: true })
  })
  const pkg = join(root, 'packages', 'shared')
  assert.equal(findFvmRoot(pkg), root)
  assert.equal(flutterCommand(pkg), 'fvm flutter')
  rmSync(root, { recursive: true })
})

test('no directory falls back to flutter', () => {
  assert.equal(flutterCommand(null), 'flutter')
})
