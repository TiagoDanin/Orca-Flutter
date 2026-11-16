import assert from 'node:assert/strict'
import { test } from 'node:test'
import { detectState, parseDevices, validDeviceId } from './run.mjs'

test('device ids with shell characters are refused', () => {
  for (const id of ['emulator-5554', 'chrome', '00008030-001A:0E', 'a.b_c']) assert.ok(validDeviceId(id), id)
  for (const id of ['', 'a b', 'x;rm -rf', '$(id)', 'a&b', "a'b", undefined, 5]) assert.ok(!validDeviceId(id), String(id))
})

test('parseDevices keeps supported devices and ignores text around the JSON', () => {
  const out = `Downloading stuff...\n[{"name":"Pixel 7","id":"emulator-5554","isSupported":true,"targetPlatform":"android-x64"},` +
    `{"name":"Old","id":"old","isSupported":false},{"name":"Bad","id":"a;b","isSupported":true}]\n`
  assert.deepEqual(parseDevices(out), [{ id: 'emulator-5554', name: 'Pixel 7', platform: 'android-x64' }])
  assert.throws(() => parseDevices('no json here'), /no JSON/)
})

test('detectState follows the newest meaningful line', () => {
  assert.equal(detectState(['Launching lib/main.dart on Pixel in debug mode...']), 'starting')
  assert.equal(detectState(['Launching lib/main.dart', 'Flutter run key commands.']), 'running')
  assert.equal(detectState(['Flutter run key commands.', 'Performing hot reload...']), 'reloading')
  assert.equal(detectState(['Performing hot reload...', 'Reloaded 1 of 500 libraries in 300ms.']), 'running')
  assert.equal(detectState(['Performing hot restart...']), 'restarting')
  assert.equal(detectState(['Flutter run key commands.', 'Application finished.']), 'idle')
  assert.equal(detectState(['some app log', 'another log']), null)
  assert.equal(detectState([]), null)
})
