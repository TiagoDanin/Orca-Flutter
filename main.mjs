import { flutterCommand } from './src/sdk.mjs'

async function focusedWorkspace(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx?.workspaceId) throw new Error('Focus a workspace first')
  const { workspaces } = await orca.host.call('workspace.list', {})
  const ws = workspaces.find((w) => w.id === ctx.workspaceId)
  // shortcut: FVM is detected only on this machine; SSH and runtime workspaces use plain `flutter`. Revisit with remote support.
  const local = !ws?.hostId || ws.hostId === 'local'
  return { id: ctx.workspaceId, flutter: flutterCommand(local ? ws?.path : null) }
}

// With enter: false the command is typed but not run, so the user can finish it (e.g. the project name).
async function runInTerminal(orca, title, args, { enter = true } = {}) {
  const { id, flutter } = await focusedWorkspace(orca)
  const text = `${flutter} ${args}`
  const params = { workspaceId: id, title }
  const { terminalId } = await orca.host.call('terminal.create', enter ? { ...params, command: text } : params)
  if (!enter) await orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  await orca.host.call('terminal.focus', { terminalId })
  return text
}

// One table feeds the command palette (`flutter.<id>`) and the sidebar panel (`flutter.run`).
const COMMANDS = {
  createProject: { title: 'Flutter: Create Project', args: 'create ', enter: false },
  doctor: { title: 'Flutter: Doctor', args: 'doctor -v' },
  upgrade: { title: 'Flutter: Upgrade', args: 'upgrade' },
  test: { title: 'Flutter: Test', args: 'test' },
  testCoverage: { title: 'Flutter: Test with Coverage', args: 'test --coverage' }
}

const run = (orca, { title, args, enter }) => runInTerminal(orca, title, args, { enter: enter !== false })

export default function activate(orca) {
  for (const [id, command] of Object.entries(COMMANDS)) {
    orca.commands.register(`flutter.${id}`, () => run(orca, command))
  }
  // The panel is a trust boundary: only ids from the table run, never an arbitrary string.
  orca.panels.handle('flutter.run', async ({ id }) => {
    if (!Object.hasOwn(COMMANDS, id)) throw new Error(`Unknown Flutter command: ${id}`)
    return { command: await run(orca, COMMANDS[id]) }
  })
}
