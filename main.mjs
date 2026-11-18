import { dirname } from 'node:path'
import { formatDart } from './src/format.mjs'
import { dartCommand } from './src/sdk.mjs'
import { createSession, sdkMode } from './src/session.mjs'

// Actions that open a new terminal with one SDK command. `tool` picks `flutter` or `dart` (both FVM-aware).
// `enter: false` types the command and leaves the rest (a name, a package) to the user.
const TERMINAL_COMMANDS = {
  createProject: { tool: 'flutter', title: 'Flutter: Create Project', args: 'create ', enter: false },
  doctor: { tool: 'flutter', title: 'Flutter: Doctor', args: 'doctor -v' },
  upgrade: { tool: 'flutter', title: 'Flutter: Upgrade', args: 'upgrade' },
  test: { tool: 'flutter', title: 'Flutter: Test', args: 'test' },
  testCoverage: { tool: 'flutter', title: 'Flutter: Test with Coverage', args: 'test --coverage' },
  pubGet: { tool: 'flutter', title: 'Flutter: Pub Get', args: 'pub get' },
  pubUpgrade: { tool: 'flutter', title: 'Flutter: Pub Upgrade', args: 'pub upgrade' },
  pubUpgradeMajor: { tool: 'flutter', title: 'Flutter: Pub Upgrade (major)', args: 'pub upgrade --major-versions' },
  pubOutdated: { tool: 'flutter', title: 'Flutter: Pub Outdated', args: 'pub outdated' },
  pubAdd: { tool: 'flutter', title: 'Flutter: Pub Add', args: 'pub add ', enter: false },
  buildRunner: {
    tool: 'dart',
    title: 'Flutter: build_runner',
    args: 'run build_runner build --delete-conflicting-outputs'
  },
  genL10n: { tool: 'flutter', title: 'Flutter: Generate Localizations', args: 'gen-l10n' },
  clean: { tool: 'flutter', title: 'Flutter: Clean', args: 'clean' },
  analyze: { tool: 'dart', title: 'Dart: Analyze', args: 'analyze' },
  format: { tool: 'dart', title: 'Dart: Format', args: 'format .' },
  pubAddDev: { tool: 'flutter', title: 'Flutter: Pub Add (dev)', args: 'pub add --dev ', enter: false },
  dartdoc: { tool: 'dart', title: 'Dart: Generate Documentation', args: 'doc' },
  fixApply: { tool: 'dart', title: 'Dart: Fix', args: 'fix --apply' }
}

// Single keys that `flutter run` understands (checked against flutter_tools resident_runner.dart, SDK 3.35).
const RUN_KEYS = {
  inspectWidget: 'i', // widget inspector on the device
  debugPaint: 'p',
  performanceOverlay: 'P',
  overridePlatform: 'o',
  toggleBrightness: 'b',
  screenshot: 's',
  openDevTools: 'v', // launches DevTools in the browser
  dumpWidgets: 'w',
  dumpRenderTree: 't'
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
    const snapshot = session.snapshot()
    const { label, tone } = STATES[snapshot.state]
    const update = (params) => orca.host.call('statusBar.update', params).catch((e) => orca.log(String(e?.message ?? e)))
    void update({ id: 'device', text: snapshot.device?.name ?? 'No device' })
    void update({ id: 'state', text: `Flutter: ${label}`, tone })
    orca.panels.post('flutter.state', snapshot)
  }

  // Every action is reachable from the command palette (`flutter.<id>`) and from the panel (`flutter.do`).
  const actions = {
    ...Object.fromEntries(
      Object.entries(TERMINAL_COMMANDS).map(([id, command]) => [id, () => session.runCommand(command)])
    ),
    ...Object.fromEntries(Object.entries(RUN_KEYS).map(([id, key]) => [id, () => session.sendKey(key)])),
    run: () => session.startRun('run'),
    runProfile: () => session.startRun('runProfile'),
    runRelease: () => session.startRun('runRelease'),
    attach: () => session.startRun('attach'),
    stop: () => session.sendKey('q'),
    hotReload: () => session.sendKey('r', 'reloading'),
    hotRestart: () => session.sendKey('R', 'restarting'),
    nextDevice: () => session.nextDevice(),
    ...Object.fromEntries(
      ['repaintRainbow', 'slowAnimations', 'debugBanner', 'paintBaselines', 'cancelInspectWidget'].map((id) => [id, () => session.vm(id)])
    ),
    rerun: () => session.rerun(),
    copyVmServiceUri: () => session.copyUri('vm'),
    copyDtdUri: () => session.copyUri('dtd'),
    pubGetAll: () => session.allProjects('get'),
    cleanAll: () => session.allProjects('clean'),
    openInXcode: () => session.openInXcode(),
    openInAndroidStudio: () => session.openInAndroidStudio(),
    widgetPreview: () => session.widgetPreview(),
    openSidebar: () => session.openSidebar()
  }

  for (const [id, action] of Object.entries(actions)) orca.commands.register(`flutter.${id}`, action)

  // The panel is a trust boundary: only ids from the table run, never an arbitrary string.
  orca.panels.handle('flutter.do', async ({ id }) => {
    if (!Object.hasOwn(actions, id)) throw new Error(`Unknown Flutter command: ${id}`)
    return { message: await actions[id]() }
  })
  orca.panels.handle('flutter.devices', async () => ({ devices: await session.devices(), ...session.snapshot() }))
  orca.panels.handle('flutter.selectDevice', async ({ id }) => ({ message: await session.selectDevice(id) }))
  orca.panels.handle('flutter.emulators', async () => ({ emulators: await session.emulators() }))
  orca.panels.handle('flutter.launchEmulator', async ({ id }) => ({ message: await session.launchEmulator(id) }))
  orca.panels.handle('flutter.openDevToolsPage', async ({ page }) => ({ message: await session.openDevToolsPage({ page }) }))
  orca.panels.handle('flutter.project', ({ platformTypes } = {}) => session.project(platformTypes))
  orca.panels.handle('flutter.enablePlatform', async ({ platform }) => ({ message: await session.enablePlatform(platform) }))
  orca.panels.handle('flutter.analyze', () => session.analyze())
  orca.panels.handle('flutter.openFile', async ({ path }) => ({ message: await session.openFile(path) }))

  // Runs on an explicit save from an editor tab (not autosave), before the file is written.
  let reloadTimer
  orca.hooks.on('editor.save.before', async (event, next) => {
    if (!event.path.endsWith('.dart')) return
    let result
    if ((await orca.settings.get('formatOnSave')) === true) {
      const dir = dirname(event.path)
      const formatted = await formatDart(dartCommand(dir, await sdkMode(orca)), event.text, dir)
      if (formatted !== null && formatted !== event.text) result = next({ ...event, text: formatted })
    }
    if ((await orca.settings.get('hotReloadOnSave')) !== false) {
      clearTimeout(reloadTimer)
      // Wait for the write to land; nothing happens when no run is active.
      reloadTimer = setTimeout(() => {
        if (session.snapshot().state !== 'idle') session.sendKey('r', 'reloading').catch((e) => orca.log(String(e?.message ?? e)))
      }, 700)
    }
    return result
  })

  process.on('exit', () => session.dispose())
  await session.init()
  setInterval(() => void session.tick(), 2000)
}
