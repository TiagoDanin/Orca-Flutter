// Pure helpers for `flutter run` and `flutter devices`. No Orca or process access, so they are unit tested.

// Device ids are typed into a shell command, so only plain id characters pass (adb serials, UDIDs, `chrome`, `windows`).
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

// Newest matching line wins. A line that matches nothing keeps the previous state (returns null).
const RULES = [
  [/Application finished\.|Lost connection to device|Exited \(\d+\)/, 'idle'],
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
