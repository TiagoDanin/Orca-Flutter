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
  assert.deepEqual(parseDevices(out), [{ id: 'emulator-5554', name: 'Pixel 7', platform: 'android-x64', platformType: 'android', emulatorId: null }])
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
  assert.deepEqual(parseEmulators(out), [{ id: 'FlutterOnly', name: 'FlutterOnly', platform: 'android', platformType: 'android' }])
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

import { pageUrl, parseDevToolsLine, parseDtdLine } from './dtd.mjs'
import { DEVTOOLS_PAGES, enablablePlatforms, platformTypeOf, packageRoots, parseExtensionName } from './run.mjs'

test('pageUrl builds DevTools page urls for a server root and for the flutter run link', () => {
  assert.equal(pageUrl('http://127.0.0.1:9101/', 'memory', { vmServiceUri: 'http://127.0.0.1:5000/abc=/' }),
    'http://127.0.0.1:9101/memory?uri=http%3A%2F%2F127.0.0.1%3A5000%2Fabc%3D%2F')
  // web: the link has a token and /devtools/ in the path, and that prefix must stay
  assert.equal(pageUrl('http://127.0.0.1:50374/TOKEN=/devtools/?uri=ws://x/ws', 'provider_ext'),
    'http://127.0.0.1:50374/TOKEN=/devtools/provider_ext')
  assert.equal(pageUrl('http://127.0.0.1:9101', 'editorSidebar', { ide: true }), 'http://127.0.0.1:9101/editorSidebar?ide=VSCode&dashTool=orca&dashIdeName=Orca')
  assert.equal(pageUrl('javascript:alert(1)', 'memory'), null)
  assert.equal(pageUrl('http://127.0.0.1:9101/', '../x'), null)
  assert.equal(pageUrl(undefined, 'memory'), null)
  for (const p of DEVTOOLS_PAGES) assert.ok(pageUrl('http://localhost:1/', p.id))
})

test('parseDtdLine and parseDevToolsLine read the machine output of dart', () => {
  assert.deepEqual(parseDtdLine('{"tooling_daemon_details":{"uri":"ws://127.0.0.1:1/x=","trusted_client_secret":"s"}}'), { uri: 'ws://127.0.0.1:1/x=', secret: 's' })
  assert.equal(parseDtdLine('Hello'), null)
  assert.deepEqual(parseDevToolsLine('{"event":"server.started","method":"server.started","params":{"host":"127.0.0.1","port":9101,"pid":1}}'), { host: '127.0.0.1', port: 9101 })
  assert.equal(parseDevToolsLine('{"event":"server.dtdStarted","params":{"uri":"ws://x"}}'), null)
})

test('platformTypeOf maps flutter targetPlatform values', () => {
  assert.equal(platformTypeOf('android-arm64'), 'android')
  assert.equal(platformTypeOf('darwin'), 'macos')
  assert.equal(platformTypeOf('web-javascript'), 'web')
  assert.equal(platformTypeOf('ios'), 'ios')
  assert.equal(platformTypeOf('wat'), null)
})

test('enablablePlatforms offers device platform types the project lacks', () => {
  assert.deepEqual(enablablePlatforms(['android', 'ios'], ['android', 'macos', 'web', 'web']), ['macos', 'web'])
  assert.deepEqual(enablablePlatforms([], ['android', 'bogus']), ['android'])
})

test('parseExtensionName reads the name key', () => {
  assert.equal(parseExtensionName('name: provider\nversion: 0.0.1\nissueTracker: x\n'), 'provider')
  assert.equal(parseExtensionName('# c\nname: "shared_preferences"\n'), 'shared_preferences')
  assert.equal(parseExtensionName('version: 1\n'), null)
})

test('packageRoots resolves relative and file uris', () => {
  const json = JSON.stringify({ packages: [{ rootUri: '../' }, { rootUri: 'file:///pub/provider-6.0.0' }, { rootUri: '../../x%20y' }] })
  const roots = packageRoots(json, '/app/.dart_tool')
  assert.deepEqual(roots, ['/app', '/pub/provider-6.0.0', '/x y'])
})

import { extractValue, nextValue, TOGGLES, vmWsUrl } from './vm.mjs'

test('vmWsUrl turns the flutter run uri into the websocket', () => {
  assert.equal(vmWsUrl('http://127.0.0.1:50374/7J-ZfKQdDhI=/'), 'ws://127.0.0.1:50374/7J-ZfKQdDhI=/ws')
  assert.equal(vmWsUrl('http://127.0.0.1:50374/7J-ZfKQdDhI='), 'ws://127.0.0.1:50374/7J-ZfKQdDhI=/ws')
  assert.equal(vmWsUrl('ws://127.0.0.1:1/x=/ws'), 'ws://127.0.0.1:1/x=/ws')
  assert.equal(vmWsUrl('file:///x'), null)
  assert.equal(vmWsUrl('nope'), null)
})

test('toggle values follow Dart-Code', () => {
  assert.equal(extractValue('true'), true)
  assert.equal(extractValue('1.0'), 1)
  assert.equal(nextValue(TOGGLES.repaintRainbow, false), true)
  assert.equal(nextValue(TOGGLES.repaintRainbow, true), false)
  assert.equal(nextValue(TOGGLES.slowAnimations, 1), 5)
  assert.equal(nextValue(TOGGLES.slowAnimations, 5), 1)
})
