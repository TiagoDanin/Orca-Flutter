// Pure helpers for `flutter run`, `flutter devices`, `flutter emulators` and `dart analyze`.
// No Orca or process access, so they are unit tested.
import { isAbsolute, relative, resolve, sep } from 'node:path'

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
    .map((d) => ({ id: d.id, name: String(d.name ?? d.id), platform: String(d.targetPlatform ?? '') }))
}

// `flutter emulators` prints a table: "Id • Name • Manufacturer • Platform", then help text without bullets.
export function parseEmulators(stdout) {
  const rows = []
  for (const line of stdout.split(/\r?\n/)) {
    const cells = line.split('•').map((cell) => cell.trim())
    if (cells.length === 4 && cells[0] !== 'Id' && validDeviceId(cells[0])) {
      rows.push({ id: cells[0], name: cells[1], platform: cells[3] })
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
