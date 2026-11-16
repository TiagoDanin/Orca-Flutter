import { createSession } from './src/session.mjs'

// Actions that open a new terminal with one SDK command. `tool` picks `flutter` or `dart` (both FVM-aware).
const TERMINAL_COMMANDS = {
  createProject: { tool: 'flutter', title: 'Flutter: Create Project', args: 'create ', enter: false },
  doctor: { tool: 'flutter', title: 'Flutter: Doctor', args: 'doctor -v' },
  upgrade: { tool: 'flutter', title: 'Flutter: Upgrade', args: 'upgrade' },
  test: { tool: 'flutter', title: 'Flutter: Test', args: 'test' },
  testCoverage: { tool: 'flutter', title: 'Flutter: Test with Coverage', args: 'test --coverage' },
  pubGet: { tool: 'flutter', title: 'Flutter: Pub Get', args: 'pub get' },
  buildRunner: {
    tool: 'dart',
    title: 'Flutter: build_runner',
    args: 'run build_runner build --delete-conflicting-outputs'
  },
  clean: { tool: 'flutter', title: 'Flutter: Clean', args: 'clean' }
}

const STATES = {
  idle: { label: 'Idle', tone: 'neutral' },
  starting: { label: 'Starting', tone: 'warning' },
  running: { label: 'Running', tone: 'success' },
  reloading: { label: 'Reloading', tone: 'warning' },
  restarting: { label: 'Restarting', tone: 'warning' }
}

export default async function activate(orca) {
  const session = createSession(orca, changed)

  function changed() {
    const { device, state } = session.snapshot()
    const { label, tone } = STATES[state]
    const update = (params) => orca.host.call('statusBar.update', params).catch((e) => orca.log(String(e?.message ?? e)))
    void update({ id: 'device', text: device?.name ?? 'No device' })
    void update({ id: 'state', text: `Flutter: ${label}`, tone })
    orca.panels.post('flutter.state', session.snapshot())
  }

  // Every action is reachable from the command palette (`flutter.<id>`) and from the panel (`flutter.do`).
  const actions = {
    ...Object.fromEntries(
      Object.entries(TERMINAL_COMMANDS).map(([id, command]) => [id, () => session.runCommand(command)])
    ),
    run: () => session.startRun(),
    stop: () => session.sendKey('q'),
    hotReload: () => session.sendKey('r', 'reloading'),
    hotRestart: () => session.sendKey('R', 'restarting'),
    nextDevice: () => session.nextDevice()
  }

  for (const [id, action] of Object.entries(actions)) orca.commands.register(`flutter.${id}`, action)

  // The panel is a trust boundary: only ids from the table run, never an arbitrary string.
  orca.panels.handle('flutter.do', async ({ id }) => {
    if (!Object.hasOwn(actions, id)) throw new Error(`Unknown Flutter command: ${id}`)
    return { message: await actions[id]() }
  })
  orca.panels.handle('flutter.devices', async () => ({
    devices: await session.devices(),
    ...session.snapshot()
  }))
  orca.panels.handle('flutter.selectDevice', async ({ id }) => ({ message: await session.selectDevice(id) }))

  await session.init()
  setInterval(() => void session.tick(), 2000)
}
