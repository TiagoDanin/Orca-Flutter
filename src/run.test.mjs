import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { test } from 'node:test'
import { formatDart } from './format.mjs'
import {
  detectState,
  extractLinks,
  isInside,
  parseAnalyze,
  parseDevices,
  parseEmulators,
  validDeviceId
} from './run.mjs'

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

test('parseEmulators reads the table from `flutter emulators` (real output)', () => {
  const out = [
    '1 available emulator:',
    '',
    'Id          • Name        • Manufacturer • Platform',
    '',
    'FlutterOnly • FlutterOnly • Generic      • android',
    '',
    "To run an emulator, run 'flutter emulators --launch <emulator id>'."
  ].join('\n')
  assert.deepEqual(parseEmulators(out), [{ id: 'FlutterOnly', name: 'FlutterOnly', platform: 'android' }])
  assert.deepEqual(parseEmulators('No emulators available.'), [])
})

test('parseAnalyze reads `dart analyze --format=machine` (real output) and unescapes it', () => {
  const out = [
    "ERROR|COMPILE_TIME_ERROR|INVALID_ASSIGNMENT|C:\\\\Users\\\\tiago\\\\a.dart|2|11|4|A value of type 'String' can't be assigned to a variable of type 'int'.",
    "WARNING|STATIC_WARNING|UNUSED_LOCAL_VARIABLE|C:\\\\Users\\\\tiago\\\\a.dart|2|7|1|The value of the local variable 'x' isn't used.",
    'INFO|LINT|x|/p/b.dart|1|1|1|pipe \\| inside',
    'Analyzing...'
  ].join('\r\n')
  const problems = parseAnalyze(out)
  assert.equal(problems.length, 3)
  assert.deepEqual(problems[0], {
    severity: 'error',
    code: 'INVALID_ASSIGNMENT',
    file: 'C:\\Users\\tiago\\a.dart',
    line: 2,
    column: 11,
    message: "A value of type 'String' can't be assigned to a variable of type 'int'."
  })
  assert.equal(problems[2].message, 'pipe | inside')
  assert.equal(parseAnalyze(out, 1).length, 1)
})

test('isInside accepts files under the root and refuses everything else', () => {
  const root = join('/', 'work', 'app')
  assert.ok(isInside(root, join(root, 'lib', 'main.dart')))
  assert.ok(!isInside(root, root))
  assert.ok(!isInside(root, join(root, '..', 'secret.txt')))
  assert.ok(!isInside(root, join('/', 'work', 'app2', 'x.dart')))
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

test('extractLinks finds the DevTools and VM Service URLs', () => {
  const lines = [
    'A Dart VM Service on Windows is available at: http://127.0.0.1:5000/abc=/',
    'The Flutter DevTools debugger and profiler on Windows is available at: http://127.0.0.1:5001?uri=http://127.0.0.1:5000/abc=/',
    'unrelated'
  ]
  assert.deepEqual(extractLinks(lines), {
    vmService: 'http://127.0.0.1:5000/abc=/',
    devTools: 'http://127.0.0.1:5001?uri=http://127.0.0.1:5000/abc=/'
  })
  assert.deepEqual(extractLinks(['nothing']), {})
})

const hasDart = (() => {
  try {
    execSync('dart --version', { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

test('formatDart formats through the real dart and leaves broken code alone', { skip: !hasDart }, async () => {
  assert.equal(await formatDart('dart', 'void main(){print( 1+2 );}\n', process.cwd()), 'void main() {\n  print(1 + 2);\n}\n')
  assert.equal(await formatDart('dart', 'void main( {', process.cwd()), null)
  assert.equal(await formatDart('definitely-not-a-command', 'x', process.cwd()), null)
})
