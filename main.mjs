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

export default function activate(orca) {
  orca.commands.register('flutter.createProject', () =>
    runInTerminal(orca, 'Flutter: Create Project', 'create ', { enter: false })
  )
  orca.commands.register('flutter.doctor', () => runInTerminal(orca, 'Flutter: Doctor', 'doctor -v'))
  orca.commands.register('flutter.upgrade', () => runInTerminal(orca, 'Flutter: Upgrade', 'upgrade'))
  orca.commands.register('flutter.test', () => runInTerminal(orca, 'Flutter: Test', 'test'))
  orca.commands.register('flutter.testCoverage', () =>
    runInTerminal(orca, 'Flutter: Test with Coverage', 'test --coverage')
  )
}
