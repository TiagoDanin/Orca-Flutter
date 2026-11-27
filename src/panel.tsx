// The Flutter Sidebar of the Dart-Code extension, drawn with Orca components: Debug Sessions, Devices,
// DevTools and DevTools Extensions, in that order, then Flutter Tools. Orca panels have no header actions, so the
// three buttons of the original header (new project, DevTools, doctor) live in the sections instead.
import {
  atom,
  Collapsible,
  Grid,
  Heading,
  IconButton,
  List,
  ListItem,
  Row,
  Stack,
  Text,
  plugin,
  read,
  set
} from 'orca'

type Device = { id: string; name: string; platform: string; platformType?: string | null; emulatorId?: string | null }
type Emulator = { id: string; name: string; platform: string; platformType?: string | null }
type Snapshot = {
  device: { id: string; name: string } | null
  configuration: string | null
  state: string
  session: { title: string; device: string | null } | null
}
type LaunchConfiguration = { name: string; args: string[]; preLaunchTask: string | null; preCommand: string | null }
type Project = { platforms: string[]; extensions: string[] }
type Problem = { severity: string; file: string; line: number; message: string; display: string }

// DevTools routes in the order of the Dart-Code sidebar (mirrored in run.mjs DEVTOOLS_PAGES).
// `needsSession`: greyed while nothing runs, as in the original.
const DEVTOOLS_PAGES: { id: string; title: string; icon: string; needsSession?: boolean }[] = [
  { id: 'inspector', title: 'Flutter Inspector', icon: 'search', needsSession: true },
  { id: 'performance', title: 'Performance', icon: 'activity' },
  { id: 'cpu-profiler', title: 'CPU Profiler', icon: 'gauge' },
  { id: 'memory', title: 'Memory', icon: 'database' },
  { id: 'network', title: 'Network', icon: 'globe' },
  { id: 'logging', title: 'Logging', icon: 'file-text', needsSession: true },
  { id: 'app-size', title: 'App Size', icon: 'package' },
  { id: 'deep-links', title: 'Deep Links', icon: 'link' },
  { id: 'dtd', title: 'DTD Tools', icon: 'settings' }
]

const DEVICE_ICONS: Record<string, string> = { android: 'rocket', ios: 'rocket', web: 'globe' }

const devices = atom<Device[]>([])
const emulators = atom<Emulator[]>([])
const selected = atom<string | null>(null)
const session = atom<Snapshot['session']>(null)
const project = atom<Project>({ platforms: [], extensions: [] })
const problems = atom<Problem[] | null>(null)
const configs = atom<LaunchConfiguration[]>([])
const configuration = atom<string | null>(null)
const result = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)

function fail(error: unknown): void {
  set(result, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
}

function apply(snapshot: Snapshot): void {
  set(selected, snapshot.device?.id ?? null)
  set(configuration, snapshot.configuration ?? null)
  set(session, snapshot.session ?? null)
}

async function guarded(work: () => Promise<string | void>): Promise<void> {
  try {
    const message = await work()
    set(result, message ? { tone: 'success', text: message } : null)
  } catch (error) {
    fail(error)
  }
}

// 120 s is the longest a request may wait: Pub Get for All Projects and starting DevTools take longer than the 30 s default.
const act = (id: string) => guarded(async () => (await plugin.request('flutter.do', { id }, { timeoutMs: 120000 })).message)

// Platform types of the devices and emulators decide which "Enable <platform>" rows show (Dart-Code device_manager.ts).
async function refreshProject(): Promise<void> {
  try {
    const types = [...read(devices).map((d) => d.platformType), ...read(emulators).map((e) => e.platformType)].filter(Boolean)
    set(project, await plugin.request('flutter.project', { platformTypes: types }, { timeoutMs: 30000 }))
  } catch (error) {
    fail(error)
  }
}

async function refreshDevices(): Promise<void> {
  try {
    const { devices: list, ...snapshot } = await plugin.request('flutter.devices', {}, { timeoutMs: 60000 })
    set(devices, list)
    apply(snapshot)
    void refreshProject()
  } catch (error) {
    fail(error)
  }
}

async function refreshEmulators(): Promise<void> {
  try {
    const { emulators: list } = await plugin.request('flutter.emulators', {}, { timeoutMs: 60000 })
    set(emulators, list as Emulator[])
    void refreshProject()
  } catch (error) {
    fail(error)
  }
}

// The Dart and Flutter entries of .vscode/launch.json, as the Dart-Code extension lists them.
async function refreshConfigurations(): Promise<void> {
  try {
    const found = await plugin.request('flutter.launchConfigurations', {}, { timeoutMs: 30000 })
    set(configs, found.configurations)
    set(configuration, found.selected ?? null)
  } catch (error) {
    fail(error)
  }
}

const pickConfiguration = (name: string) =>
  guarded(async () => {
    const message = (await plugin.request('flutter.selectConfiguration', { name }, { timeoutMs: 30000 })).message
    void refreshConfigurations()
    return message
  })

const pick = (id: string) =>
  guarded(async () => (await plugin.request('flutter.selectDevice', { id }, { timeoutMs: 60000 })).message)

// Starts the emulator or simulator, then looks for the new device while it boots.
const launchEmulator = (id: string) =>
  guarded(async () => {
    const message = (await plugin.request('flutter.launchEmulator', { id })).message
    if (typeof setTimeout === 'function') for (const seconds of [15, 30, 60]) setTimeout(() => void refreshDevices(), seconds * 1000)
    return message
  })

const enablePlatform = (platform: string) =>
  guarded(async () => (await plugin.request('flutter.enablePlatform', { platform })).message)

// A DevTools page opens in a browser tab inside Orca, connected to the running app.
const openDevTools = (page: string) =>
  guarded(async () => (await plugin.request('flutter.openDevToolsPage', { page }, { timeoutMs: 60000 })).message)

const analyze = () =>
  guarded(async () => {
    set(problems, null)
    const found = await plugin.request('flutter.analyze', {}, { timeoutMs: 120000 })
    set(problems, found.problems)
    return found.problems.length === 0 ? 'No problems found.' : `${found.problems.length} problems.`
  })

const openProblem = (file: string) =>
  guarded(async () => (await plugin.request('flutter.openFile', { path: file })).message)

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: { subscriptions: unknown[] }): void {
  ctx.subscriptions.push(plugin.on('flutter.state', apply))
  void refreshConfigurations()
  void refreshDevices()
  void refreshEmulators()
}

// Nothing to show without a launch.json, and most projects do not have one.
function LaunchConfigurations() {
  const list = read(configs)
  const chosen = read(configuration)
  if (list.length === 0) return null
  return (
    <Stack gap="xs">
      <Heading>Configuration</Heading>
      <List label="Launch configurations">
        {list.map((c) => (
          <ListItem
            key={c.name}
            icon="play"
            title={c.name}
            description={c.args.length > 0 ? c.args.join(' ') : undefined}
            current={c.name === chosen}
            onPress={() => void pickConfiguration(c.name)}
          />
        ))}
      </List>
    </Stack>
  )
}

function DebugSessions() {
  const current = read(session)
  return (
    <Stack gap="xs">
      <Heading>Debug Sessions</Heading>
      {current ? (
        <>
          <List label="Debug sessions">
            <ListItem icon="bug" title={current.title} description={current.device ?? undefined} current />
          </List>
          <Row gap="xs">
            <IconButton icon="zap" label="Hot Reload" onPress={() => void act('hotReload')} />
            <IconButton icon="refresh" label="Hot Restart" onPress={() => void act('hotRestart')} />
            <IconButton icon="stop" label="Stop" onPress={() => void act('stop')} />
          </Row>
        </>
      ) : (
        <Text muted>No debug sessions</Text>
      )}
    </Stack>
  )
}

function Devices() {
  const list = read(devices)
  const chosen = read(selected)
  const { platforms } = read(project)
  // As in the Dart-Code device picker: emulators that are not already running, as "Offline Emulators".
  const running = new Set(list.map((d) => d.emulatorId).filter(Boolean))
  const offline = read(emulators).filter((e) => !running.has(e.id))
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Heading>Devices</Heading>
        <IconButton icon="refresh" label="Refresh devices" onPress={() => void refreshDevices()} />
      </Row>
      {list.length === 0 ? <Text muted>Connect a device or enable a platform</Text> : null}
      <List label="Devices">
        {list.map((d) => (
          <ListItem
            key={d.id}
            icon={DEVICE_ICONS[d.platformType ?? ''] ?? 'terminal'}
            title={d.name}
            current={d.id === chosen}
            onPress={() => void pick(d.id)}
          />
        ))}
        {platforms.map((p) => (
          <ListItem key={p} title={`Enable ${p} for this project`} onPress={() => void enablePlatform(p)} />
        ))}
      </List>
      {offline.length > 0 ? (
        <>
          <Text muted size="xs">Offline Emulators</Text>
          <List label="Offline emulators">
            {offline.map((e) => (
              <ListItem key={e.id} icon="play" title={e.name} description={e.platform} onPress={() => void launchEmulator(e.id)} />
            ))}
          </List>
        </>
      ) : null}
    </Stack>
  )
}

function DevTools() {
  const running = read(session) !== null
  const { extensions } = read(project)
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Heading>DevTools</Heading>
        <IconButton icon="open-external" label="Open DevTools in the browser" onPress={() => void act('openDevTools')} />
      </Row>
      <Grid columns={2} gap="xs">
        {[0, 1].map((column) => (
          <List key={column} label={column === 0 ? 'DevTools pages' : 'More DevTools pages'}>
            {DEVTOOLS_PAGES.filter((_, i) => i % 2 === column).map((p) => (
              <ListItem
                key={p.id}
                icon={p.icon}
                title={p.title}
                disabled={p.needsSession && !running}
                onPress={() => void openDevTools(p.id)}
              />
            ))}
          </List>
        ))}
      </Grid>
      {extensions.length > 0 ? (
        <>
          <Heading>DevTools Extensions</Heading>
          <List label="DevTools extensions">
            {extensions.map((name) => (
              <ListItem key={name} icon="puzzle" title={name} disabled={!running} onPress={() => void openDevTools(`${name}_ext`)} />
            ))}
          </List>
        </>
      ) : null}
    </Stack>
  )
}

type Tool = { id: string; title: string; icon: string }

// What the Dart-Code extension spreads over the debug toolbar, the palette and the Problems, Testing and
// Dependencies views. Orca has none of those, so they are grouped here, collapsed, under one heading.
const TOOL_GROUPS: { title: string; tools: Tool[] }[] = [
  {
    title: 'Run',
    tools: [
      { id: 'run', title: 'Run', icon: 'play' },
      { id: 'runProfile', title: 'Profile', icon: 'gauge' },
      { id: 'runRelease', title: 'Release', icon: 'rocket' },
      { id: 'attach', title: 'Attach', icon: 'link' },
      { id: 'rerun', title: 'Rerun', icon: 'refresh' }
    ]
  },
  {
    title: 'Debug',
    tools: [
      { id: 'inspectWidget', title: 'Inspect Widget', icon: 'search' },
      { id: 'cancelInspectWidget', title: 'Cancel Inspect', icon: 'close' },
      { id: 'debugPaint', title: 'Debug Paint', icon: 'edit' },
      { id: 'repaintRainbow', title: 'Repaint Rainbow', icon: 'edit' },
      { id: 'slowAnimations', title: 'Slow Animations', icon: 'pause' },
      { id: 'debugBanner', title: 'Debug Banner', icon: 'flag' },
      { id: 'paintBaselines', title: 'Baselines', icon: 'code' },
      { id: 'performanceOverlay', title: 'Perf Overlay', icon: 'activity' },
      { id: 'overridePlatform', title: 'Platform', icon: 'layers' },
      { id: 'toggleBrightness', title: 'Brightness', icon: 'star' },
      { id: 'screenshot', title: 'Screenshot', icon: 'download' },
      { id: 'dumpWidgets', title: 'Widget Tree', icon: 'file-text' },
      { id: 'dumpRenderTree', title: 'Render Tree', icon: 'file-text' }
    ]
  },
  {
    title: 'Project',
    tools: [
      { id: 'pubGet', title: 'Pub Get', icon: 'download' },
      { id: 'pubGetAll', title: 'Pub Get (all)', icon: 'download' },
      { id: 'pubUpgrade', title: 'Pub Upgrade', icon: 'upload' },
      { id: 'pubOutdated', title: 'Pub Outdated', icon: 'info' },
      { id: 'pubAdd', title: 'Pub Add', icon: 'add' },
      { id: 'pubAddDev', title: 'Pub Add (dev)', icon: 'add' },
      { id: 'buildRunner', title: 'build_runner', icon: 'hammer' },
      { id: 'genL10n', title: 'Gen L10n', icon: 'globe' },
      { id: 'clean', title: 'Clean', icon: 'delete' },
      { id: 'cleanAll', title: 'Clean (all)', icon: 'delete' },
      { id: 'dartdoc', title: 'Dart Doc', icon: 'book' }
    ]
  },
  {
    title: 'Tests',
    tools: [
      { id: 'test', title: 'Run Tests', icon: 'check' },
      { id: 'testCoverage', title: 'Coverage', icon: 'gauge' }
    ]
  },
  {
    title: 'SDK',
    tools: [
      { id: 'createProject', title: 'Create Project', icon: 'add' },
      { id: 'doctor', title: 'Flutter Doctor', icon: 'check' },
      { id: 'upgrade', title: 'Flutter Upgrade', icon: 'download' },
      { id: 'widgetPreview', title: 'Widget Preview', icon: 'layers' },
      { id: 'openInXcode', title: 'Open in Xcode', icon: 'code' },
      { id: 'openInAndroidStudio', title: 'Open in Android Studio', icon: 'code' },
      { id: 'copyVmServiceUri', title: 'Copy VM URI', icon: 'copy' },
      { id: 'copyDtdUri', title: 'Copy DTD URI', icon: 'copy' }
    ]
  }
]

// Two columns, like the DevTools pages above.
function ToolList({ tools }: { tools: Tool[] }) {
  return (
    <Grid columns={2} gap="xs">
      {[0, 1].map((column) => (
        <List key={column} label={column === 0 ? 'Tools' : 'More tools'}>
          {tools
            .filter((_, i) => i % 2 === column)
            .map((t) => (
              <ListItem key={t.id} icon={t.icon} title={t.title} onPress={() => void act(t.id)} />
            ))}
        </List>
      ))}
    </Grid>
  )
}

function Problems() {
  const list = read(problems)
  if (list === null) return null
  return (
    <List label="Problems">
      {list.slice(0, 50).map((p, i) => (
        <ListItem
          key={`${p.file}:${p.line}:${i}`}
          icon={p.severity === 'error' ? 'error' : p.severity === 'warning' ? 'warning' : 'info'}
          title={p.message}
          description={`${p.display}:${p.line}`}
          onPress={() => void openProblem(p.file)}
        />
      ))}
    </List>
  )
}

function FlutterTools() {
  return (
    <Stack gap="xs">
      <Heading>Flutter Tools</Heading>
      {TOOL_GROUPS.map((group) => (
        <Collapsible key={group.title} title={group.title} defaultOpen={group.title === 'Run'}>
          <ToolList tools={group.tools} />
        </Collapsible>
      ))}
      <Collapsible title="Problems">
        <Stack gap="xs">
          <List label="Problem tools">
            <ListItem icon="search" title="Analyze" onPress={() => void analyze()} />
            <ListItem icon="wrench" title="Dart Fix" onPress={() => void act('fixApply')} />
            <ListItem icon="code" title="Dart Format" onPress={() => void act('format')} />
          </List>
          <Problems />
        </Stack>
      </Collapsible>
    </Stack>
  )
}

export default function Panel() {
  const last = read(result)
  return (
    <Stack gap="md">
      <Stack gap="xs">
        <Heading>Flutter for Orca</Heading>
        <Text muted size="xs">(unofficial) by Tiago Danin</Text>
      </Stack>
      <LaunchConfigurations />
      <DebugSessions />
      <Devices />
      <DevTools />
      <FlutterTools />
      {last ? <Text tone={last.tone}>{last.text}</Text> : null}
    </Stack>
  )
}
