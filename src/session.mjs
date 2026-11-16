import { exec } from 'node:child_process'
import { promisify } from 'node:util'
import { detectState, parseDevices, validDeviceId } from './run.mjs'
import { dartCommand, flutterCommand } from './sdk.mjs'

const execAsync = promisify(exec)

async function focusedWorkspace(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx?.workspaceId) throw new Error('Focus a workspace first')
  const { workspaces } = await orca.host.call('workspace.list', {})
  const ws = workspaces.find((w) => w.id === ctx.workspaceId)
  // shortcut: FVM is detected only on this machine; SSH and runtime workspaces use plain `flutter`. Revisit with remote support.
  const path = !ws?.hostId || ws.hostId === 'local' ? (ws?.path ?? null) : null
  return { id: ctx.workspaceId, path, flutter: flutterCommand(path), dart: dartCommand(path) }
}

// With enter: false the command is typed but not run, so the user can finish it (e.g. the project name).
async function openTerminal(orca, workspaceId, title, text, { enter = true } = {}) {
  const params = { workspaceId, title }
  const { terminalId } = await orca.host.call('terminal.create', enter ? { ...params, command: text } : params)
  if (!enter) await orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  await orca.host.call('terminal.focus', { terminalId })
  return terminalId
}

// One Flutter run per plugin: the selected device and the terminal running `flutter run`.
// onChange fires whenever either changes, so the status bar and the panel can redraw.
export function createSession(orca, onChange) {
  let device = null // { id, name }
  let run = null // { terminalId, state }

  const snapshot = () => ({ device, state: run?.state ?? 'idle' })
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
    if (!ws.path) throw new Error('Listing devices needs a local workspace')
    // The command is built only from constants (`flutter` or `fvm flutter`), so the shell is safe here.
    const { stdout } = await execAsync(`${ws.flutter} devices --machine`, {
      cwd: ws.path,
      timeout: 60_000,
      windowsHide: true
    })
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

  async function startRun() {
    if (run) {
      try {
        await orca.host.call('terminal.focus', { terminalId: run.terminalId })
        return 'Already running: showing its terminal'
      } catch {
        run = null // the terminal was closed
      }
    }
    const ws = await focusedWorkspace(orca)
    const text = `${ws.flutter} run${device ? ` -d ${device.id}` : ''}`
    const terminalId = await openTerminal(orca, ws.id, 'Flutter: Run', text)
    setRun({ terminalId, state: 'starting' })
    return text
  }

  // Flutter reads single keys from its terminal: r reload, R restart, q quit.
  async function sendKey(text, state) {
    if (!run) throw new Error('Nothing is running. Run the app first.')
    await orca.host.call('terminal.sendText', { terminalId: run.terminalId, text, enter: false })
    if (state) setRun({ ...run, state })
    return `Sent "${text}" to flutter run`
  }

  async function tick() {
    if (!run) return
    try {
      const { lines } = await orca.host.call('terminal.read', { terminalId: run.terminalId, maxLines: 60 })
      const state = detectState(lines)
      if (state === 'idle') setRun(null)
      else if (state && state !== run.state) setRun({ ...run, state })
    } catch {
      setRun(null) // the terminal is gone
    }
  }

  return { init, snapshot, runCommand, devices, selectDevice, nextDevice, startRun, sendKey, tick }
}
