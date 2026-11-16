import { exec } from 'node:child_process'
import { relative } from 'node:path'
import { promisify } from 'node:util'
import {
  detectState,
  extractLinks,
  isInside,
  parseAnalyze,
  parseDevices,
  parseEmulators,
  validDeviceId
} from './run.mjs'
import { dartCommand, flutterCommand, SDK_MODES } from './sdk.mjs'

const execAsync = promisify(exec)

// Long-running sessions. All of them accept r, R and q in their terminal.
const RUN_KINDS = {
  run: { title: 'Flutter: Run', args: 'run' },
  runProfile: { title: 'Flutter: Run (Profile)', args: 'run --profile' },
  runRelease: { title: 'Flutter: Run (Release)', args: 'run --release' },
  attach: { title: 'Flutter: Attach', args: 'attach' }
}

// The sdkMode setting: `auto` follows the project's FVM pin, `fvm` and `flutter` force one.
export async function sdkMode(orca) {
  const mode = await orca.settings.get('sdkMode')
  return SDK_MODES.includes(mode) ? mode : 'auto'
}

async function focusedWorkspace(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx?.workspaceId) throw new Error('Focus a workspace first')
  const { workspaces } = await orca.host.call('workspace.list', {})
  const ws = workspaces.find((w) => w.id === ctx.workspaceId)
  // shortcut: FVM is detected only on this machine; SSH and runtime workspaces use plain `flutter`. Revisit with remote support.
  const path = !ws?.hostId || ws.hostId === 'local' ? (ws?.path ?? null) : null
  const mode = await sdkMode(orca)
  return { id: ctx.workspaceId, path, flutter: flutterCommand(path, mode), dart: dartCommand(path, mode) }
}

// With enter: false the command is typed but not run, so the user can finish it (e.g. the project name).
async function openTerminal(orca, workspaceId, title, text, { enter = true } = {}) {
  const params = { workspaceId, title }
  const { terminalId } = await orca.host.call('terminal.create', enter ? { ...params, command: text } : params)
  if (!enter) await orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  await orca.host.call('terminal.focus', { terminalId })
  return terminalId
}

// The command is built only from constants (`flutter`, `fvm flutter`, `dart`, `fvm dart` and fixed arguments),
// so running it through the shell is safe. Used for quick commands whose output the worker reads.
function runHere(command, ws, { timeout = 60_000 } = {}) {
  if (!ws.path) throw new Error('This needs a local workspace')
  return execAsync(command, { cwd: ws.path, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

// One Flutter run per plugin: the selected device and the terminal running `flutter run`.
// onChange fires whenever either changes, so the status bar and the panel can redraw.
export function createSession(orca, onChange) {
  let device = null // { id, name }
  let run = null // { terminalId, state, links: { devTools?, vmService? } }

  const snapshot = () => ({ device, state: run?.state ?? 'idle', links: run?.links ?? {} })
  const setRun = (next) => {
    run = next
    onChange()
  }

  async function init() {
    const stored = await orca.storage.get('device')
    // Storage is shared with the panel, so the stored id is input like any other.
    if (stored && validDeviceId(stored.id) && typeof stored.name === 'string') {
      device = { id: stored.id, name: stored.name }
    }
    onChange()
  }

  async function runCommand({ tool, title, args, enter }) {
    const ws = await focusedWorkspace(orca)
    const text = `${ws[tool]} ${args}`
    await openTerminal(orca, ws.id, title, text, { enter: enter !== false })
    return text
  }

  async function devices() {
    const ws = await focusedWorkspace(orca)
    const { stdout } = await runHere(`${ws.flutter} devices --machine`, ws)
    return parseDevices(stdout)
  }

  async function choose(next) {
    device = { id: next.id, name: next.name }
    await orca.storage.set('device', device)
    onChange()
    return `Device: ${device.name}`
  }

  async function selectDevice(id) {
    const found = (await devices()).find((d) => d.id === id)
    if (!found) throw new Error(`Device not found: ${id}`)
    return choose(found)
  }

  async function nextDevice() {
    const list = await devices()
    if (list.length === 0) throw new Error('No devices found. Start an emulator or connect a device.')
    const at = list.findIndex((d) => d.id === device?.id)
    return choose(list[(at + 1) % list.length])
  }

  async function emulators() {
    const ws = await focusedWorkspace(orca)
    const { stdout } = await runHere(`${ws.flutter} emulators`, ws)
    return parseEmulators(stdout)
  }

  async function launchEmulator(id) {
    if (!validDeviceId(id)) throw new Error(`Invalid emulator id: ${id}`)
    return runCommand({ tool: 'flutter', title: 'Flutter: Launch Emulator', args: `emulators --launch ${id}` })
  }

  async function startRun(kindId = 'run') {
    const kind = RUN_KINDS[kindId]
    if (run) {
      try {
        await orca.host.call('terminal.focus', { terminalId: run.terminalId })
        return 'Already running: showing its terminal'
      } catch {
        run = null // the terminal was closed
      }
    }
    const ws = await focusedWorkspace(orca)
    const text = `${ws.flutter} ${kind.args}${device ? ` -d ${device.id}` : ''}`
    const terminalId = await openTerminal(orca, ws.id, kind.title, text)
    setRun({ terminalId, state: 'starting', links: {} })
    return text
  }

  // Flutter reads single keys from its terminal (r reload, R restart, q quit, p debug paint, v DevTools...).
  async function sendKey(text, state) {
    if (!run) throw new Error('Nothing is running. Run the app first.')
    await orca.host.call('terminal.sendText', { terminalId: run.terminalId, text, enter: false })
    if (state) setRun({ ...run, state })
    return `Sent "${text}" to flutter run`
  }

  // `dart analyze` exits non-zero when it finds problems, but the report is still on stdout.
  async function analyze() {
    const ws = await focusedWorkspace(orca)
    let stdout
    try {
      ;({ stdout } = await runHere(`${ws.dart} analyze --format=machine`, ws, { timeout: 120_000 }))
    } catch (error) {
      if (typeof error.stdout !== 'string' || error.stdout === '') throw error
      stdout = error.stdout
    }
    const problems = parseAnalyze(stdout).map((p) => ({ ...p, display: relative(ws.path, p.file).replaceAll('\\', '/') }))
    return { problems }
  }

  // The panel sends the path, so only files inside the focused workspace are opened.
  async function openFile(file) {
    const ws = await focusedWorkspace(orca)
    if (!ws.path || typeof file !== 'string' || !isInside(ws.path, file)) {
      throw new Error('That file is not in the focused workspace')
    }
    const shown = relative(ws.path, file).replaceAll('\\', '/')
    // shortcut: the docs do not say whether editor.open takes an absolute or a workspace-relative path; try both.
    try {
      await orca.host.call('editor.open', { workspaceId: ws.id, path: file })
    } catch {
      await orca.host.call('editor.open', { workspaceId: ws.id, path: shown })
    }
    return `Opened ${shown}`
  }

  async function tick() {
    if (!run) return
    try {
      const { lines } = await orca.host.call('terminal.read', { terminalId: run.terminalId, maxLines: 60 })
      const state = detectState(lines)
      const links = { ...run.links, ...extractLinks(lines) }
      if (state === 'idle') setRun(null)
      else if ((state && state !== run.state) || JSON.stringify(links) !== JSON.stringify(run.links)) {
        setRun({ ...run, state: state ?? run.state, links })
      }
    } catch {
      setRun(null) // the terminal is gone
    }
  }

  return {
    init,
    snapshot,
    runCommand,
    devices,
    selectDevice,
    nextDevice,
    emulators,
    launchEmulator,
    startRun,
    sendKey,
    analyze,
    openFile,
    tick
  }
}
