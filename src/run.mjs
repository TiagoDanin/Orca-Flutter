// Pure helpers for `flutter run`, `flutter devices`, `flutter emulators` and `dart analyze`.
// No Orca or process access, so they are unit tested.
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

// Device and emulator ids are typed into a shell command, so only plain id characters pass
// (adb serials, UDIDs, `chrome`, `windows`, AVD names).
export const validDeviceId = (id) => typeof id === 'string' && /^[A-Za-z0-9._:-]+$/.test(id)

// `flutter devices --machine` prints a JSON array; take it from the first [ to the last ] in case a banner precedes it.
export function parseDevices(stdout) {
  const start = stdout.indexOf('[')
  const end = stdout.lastIndexOf(']')
  if (start < 0 || end < start) throw new Error('flutter devices returned no JSON')
  return JSON.parse(stdout.slice(start, end + 1))
    .filter((d) => d.isSupported !== false && validDeviceId(d.id))
    .map((d) => ({ id: d.id, name: String(d.name ?? d.id), platform: String(d.targetPlatform ?? ''), platformType: platformTypeOf(d.targetPlatform), emulatorId: typeof d.emulatorId === 'string' ? d.emulatorId : null }))
}

// `flutter emulators` prints a table: "Id • Name • Manufacturer • Platform", then help text without bullets.
export function parseEmulators(stdout) {
  const rows = []
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.split('•').map((cell) => cell.trim())
    if (cells.length === 4 && cells[0] !== 'Id' && validDeviceId(cells[0])) {
      rows.push({ id: cells[0], name: cells[1], platform: cells[3], platformType: cells[3] })
    }
  }
  return rows
}

// `dart analyze --format=machine`: SEVERITY|TYPE|CODE|FILE|LINE|COL|LENGTH|MESSAGE, with \\ and \| escaped.
function splitMachineLine(line) {
  const cells = ['']
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '\\' && i + 1 < line.length) cells[cells.length - 1] += line[++i]
    else if (line[i] === '|') cells.push('')
    else cells[cells.length - 1] += line[i]
  }
  return cells
}

export function parseAnalyze(stdout, limit = 200) {
  const problems = []
  for (const line of stdout.split(/\r?\n/)) {
    const c = splitMachineLine(line)
    if (c.length < 8 || !/^(ERROR|WARNING|INFO)$/.test(c[0])) continue
    problems.push({
      severity: c[0].toLowerCase(),
      code: c[2],
      file: c[3],
      line: Number(c[4]),
      column: Number(c[5]),
      message: c.slice(7).join('|')
    })
    if (problems.length >= limit) break
  }
  return problems
}

// The panel sends file paths, so the worker only opens files inside the workspace.
export function isInside(root, file) {
  const rel = relative(resolve(root), resolve(file))
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

// Newest matching line wins. A line that matches nothing keeps the previous state (returns null).
const RULES = [
  [/Application finished\.|Lost connection to device/, 'idle'],
  [/Performing hot reload/, 'reloading'],
  [/Performing hot restart/, 'restarting'],
  [/Reloaded \d+ of \d+ libraries|Restarted application in|Flutter run key commands/, 'running'],
  [/Launching |Running Gradle task|Running Xcode build|Building /, 'starting']
]

export function detectState(lines) {
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const [pattern, state] of RULES) if (pattern.test(lines[i])) return state
  }
  return null
}

// `flutter run` prints "The Flutter DevTools debugger and profiler on <device> is available at: <url>" and
// "A Dart VM Service on <device> is available at: <url>".
export function extractLinks(lines) {
  const links = {}
  for (const line of lines) {
    const devTools = /Flutter DevTools debugger and profiler on .* is available at: (https?:\/\/\S+)/.exec(line)
    if (devTools) links.devTools = devTools[1]
    const vmService = /A Dart VM Service on .* is available at: (https?:\/\/\S+)/.exec(line)
    if (vmService) links.vmService = vmService[1]
  }
  return links
}

// DevTools pages, in the order of the Dart-Code sidebar. `id` is the DevTools route.
export const DEVTOOLS_PAGES = [
  { id: 'inspector', title: 'Flutter Inspector', icon: 'search' },
  { id: 'performance', title: 'Performance', icon: 'activity' },
  { id: 'cpu-profiler', title: 'CPU Profiler', icon: 'gauge' },
  { id: 'memory', title: 'Memory', icon: 'database' },
  { id: 'network', title: 'Network', icon: 'globe' },
  { id: 'logging', title: 'Logging', icon: 'file-text' },
  { id: 'app-size', title: 'App Size', icon: 'package' },
  { id: 'deep-links', title: 'Deep Links', icon: 'link' },
  { id: 'dtd', title: 'DTD Tools', icon: 'settings' }
]

export const PLATFORMS = ['android', 'ios', 'web', 'macos', 'linux', 'windows', 'fuchsia']

// `flutter devices --machine` has targetPlatform only (android-arm64, darwin, web-javascript...); the Dart-Code
// daemon adds platformType (android, macos, web...). Same mapping, by prefix.
export function platformTypeOf(targetPlatform) {
  const t = String(targetPlatform ?? '')
  if (t.startsWith('android')) return 'android'
  if (t.startsWith('ios')) return 'ios'
  if (t === 'darwin') return 'macos'
  if (t.startsWith('web')) return 'web'
  if (t.startsWith('linux')) return 'linux'
  if (t.startsWith('windows')) return 'windows'
  if (t.startsWith('fuchsia')) return 'fuchsia'
  return null
}

// Dart-Code device_manager.ts: "Enable <p> for this project" is offered for the platform types of the devices and
// emulators that the project does not support. `present` is the folder names of the project (android, web...).
export function enablablePlatforms(present, platformTypes) {
  const have = new Set(present)
  return [...new Set(platformTypes)].filter((p) => PLATFORMS.includes(p) && !have.has(p))
}

// A DevTools extension of a package lives in `extension/devtools/config.yaml` and has a `name:` key.
export function parseExtensionName(yaml) {
  const match = /^name:\s*["']?([A-Za-z0-9_-]+)["']?\s*$/m.exec(yaml)
  return match ? match[1] : null
}

// Package roots from `.dart_tool/package_config.json`. rootUri is relative to that file or a file: URI.
export function packageRoots(configJson, configDir) {
  const roots = []
  for (const pkg of JSON.parse(configJson).packages ?? []) {
    if (typeof pkg.rootUri !== 'string') continue
    try {
      roots.push(pkg.rootUri.startsWith('file:') ? fileURLToPath(pkg.rootUri) : resolve(configDir, decodeURI(pkg.rootUri)))
    } catch {
      // skip a malformed uri
    }
  }
  return roots
}
