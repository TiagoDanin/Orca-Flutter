import assert from 'node:assert/strict'
import { test } from 'node:test'
import { launchConfigurations, runCommandText, stripJsonc } from './launch.mjs'

const LAUNCH = `{
  // Per-environment entries, like mobile-indigo's .vscode/launch.json
  "version": "0.2.0",
  "configurations": [
    {
      "type": "dart",
      "request": "launch",
      "name": "uat",
      "preLaunchTask": "setup_uat_env",
      "args": ["--flavor", "uat", "--no-dds"],
    },
    { "type": "dart", "request": "launch", "name": "dev", "args": ["--flavor", "dev"] },
    { "type": "node", "request": "launch", "name": "not dart" },
  ],
}`

const TASKS = `{
  "version": "2.0.0",
  "tasks": [
    { "label": "setup_uat_env", "type": "shell", "command": "./setup_env.sh uat" },
    { "label": "no command", "type": "npm" },
  ],
}`

test('stripJsonc keeps commas inside strings and drops the trailing ones', () => {
  assert.equal(stripJsonc('{"a": "x, }", "b": [1, 2,],}'), '{"a": "x, }", "b": [1, 2]}')
  assert.equal(stripJsonc('// comment\n{"a": /* block */ 1}'), '\n{"a":  1}')
})

test('launchConfigurations keeps the dart entries and resolves their preLaunchTask command', () => {
  const list = launchConfigurations(LAUNCH, TASKS)
  assert.deepEqual(
    list.map((c) => [c.name, c.args, c.preLaunchTask, c.preCommand]),
    [
      ['uat', ['--flavor', 'uat', '--no-dds'], 'setup_uat_env', './setup_env.sh uat'],
      ['dev', ['--flavor', 'dev'], null, null]
    ]
  )
})

test('launchConfigurations accepts missing files, a missing task list and a task without a shell command', () => {
  assert.deepEqual(launchConfigurations(null, null), [])
  assert.deepEqual(launchConfigurations('{"configurations": [{"type": "flutter", "name": "x", "preLaunchTask": "t"}]}', null), [
    { name: 'x', args: [], preLaunchTask: 't', preCommand: null }
  ])
  assert.equal(launchConfigurations(LAUNCH, JSON.stringify({ tasks: [{ label: 'setup_uat_env', type: 'npm' }] }))[0].preCommand, null)
})

test('runCommandText puts the preLaunchTask first and the device last', () => {
  assert.equal(
    runCommandText('fvm flutter run', ['--flavor', 'uat', '--no-dds'], './setup_env.sh uat', 'emulator-5554'),
    './setup_env.sh uat && fvm flutter run --flavor uat --no-dds -d emulator-5554'
  )
  assert.equal(runCommandText('fvm flutter run'), 'fvm flutter run')
  assert.equal(runCommandText('fvm flutter run', ['--dart-define=A=b c'], null, null), "fvm flutter run '--dart-define=A=b c'")
})
