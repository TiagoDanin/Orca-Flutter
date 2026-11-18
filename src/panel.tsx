// Components panel: Orca draws these controls, so it follows the app theme with no HTML or CSS.
import {
  atom,
  Badge,
  Button,
  Heading,
  IconButton,
  Link,
  List,
  ListItem,
  Row,
  Select,
  Stack,
  Text,
  plugin,
  read,
  set
} from 'orca'

type Device = { id: string; name: string; platform: string; platformType?: string | null }
type Emulator = { id: string; name: string; platform: string; platformType?: string | null }
type Problem = { severity: string; code: string; file: string; line: number; message: string; display: string }
type Links = { devTools?: string; vmService?: string }
type Snapshot = {
  device: { id: string; name: string } | null
  state: string
  links: Links
  session: { title: string; device: string | null } | null
}
type Project = { platforms: string[]; extensions: string[] }

// DevTools routes, in the order of the Dart-Code sidebar (mirrored in run.mjs DEVTOOLS_PAGES).
const DEVTOOLS_PAGES: { id: string; title: string; icon: string }[] = [
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

const MAX_PROBLEMS = 50

const devices = atom<Device[]>([])
const emulators = atom<Emulator[]>([])
const selected = atom<string | null>(null)
const emulator = atom<string | null>(null)
const runState = atom('idle')
const links = atom<Links>({})
const session = atom<Snapshot['session']>(null)
const project = atom<Project>({ platforms: [], extensions: [] })
const problems = atom<Problem[] | null>(null)
const busy = atom(false)
const result = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)

const TONES: Record<string, 'neutral' | 'warning' | 'success'> = {
  idle: 'neutral',
  starting: 'warning',
  running: 'success',
  reloading: 'warning',
  restarting: 'warning'
}

const SEVERITY_ICONS: Record<string, string> = { error: 'error', warning: 'warning', info: 'info' }

function fail(error: unknown): void {
  set(result, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
}

function apply(snapshot: Snapshot): void {
  set(runState, snapshot.state)
  set(selected, snapshot.device?.id ?? null)
  set(links, snapshot.links ?? {})
  set(session, snapshot.session ?? null)
}

// Runs a request with the busy flag on and shows its message (or its error) under the buttons.
async function guarded(work: () => Promise<string | void>): Promise<void> {
  set(busy, true)
  try {
    const message = await work()
    if (message) set(result, { tone: 'success', text: message })
  } catch (error) {
    fail(error)
  } finally {
    set(busy, false)
  }
}

const act = (id: string) =>
  guarded(async () => (await plugin.request('flutter.do', { id })).message)

async function refreshDevices(): Promise<void> {
  try {
    const { devices: list, ...snapshot } = await plugin.request('flutter.devices', {}, { timeoutMs: 60000 })
    set(devices, list)
    apply(snapshot)
    void refreshProject()
    set(result, list.length === 0 ? { tone: 'danger', text: 'No devices found. Start an emulator or connect a device.' } : null)
  } catch (error) {
    fail(error)
  }
}

async function refreshEmulators(): Promise<void> {
  try {
    const { emulators: list } = await plugin.request('flutter.emulators', {}, { timeoutMs: 60000 })
    set(emulators, list)
    set(emulator, list[0]?.id ?? null)
    void refreshProject()
  } catch (error) {
    fail(error)
  }
}

const pick = (id: string) =>
  guarded(async () => (await plugin.request('flutter.selectDevice', { id }, { timeoutMs: 60000 })).message)

const launchEmulator = () => {
  const id = read(emulator)
  return id ? guarded(async () => (await plugin.request('flutter.launchEmulator', { id })).message) : Promise.resolve()
}

const analyze = () =>
  guarded(async () => {
    set(problems, null)
    const found = await plugin.request('flutter.analyze', {}, { timeoutMs: 120000 })
    set(problems, found.problems)
    return found.problems.length === 0 ? 'No problems found.' : `${found.problems.length} problems.`
  })

async function refreshProject(): Promise<void> {
  try {
    // Platform types of the devices and emulators, as Dart-Code uses them to offer "Enable <platform>".
    const types = [...read(devices).map((d) => d.platformType), ...read(emulators).map((e) => e.platformType)].filter(Boolean)
    set(project, await plugin.request('flutter.project', { platformTypes: types }, { timeoutMs: 30000 }))
  } catch (error) {
    fail(error)
  }
}

const enablePlatform = (platform: string) =>
  guarded(async () => (await plugin.request('flutter.enablePlatform', { platform })).message)

// Opens a DevTools page in a browser tab inside Orca, connected to the running app.
const openDevTools = (page: string) =>
  guarded(async () => (await plugin.request('flutter.openDevToolsPage', { page }, { timeoutMs: 60000 })).message)

const openProblem = (file: string) =>
  guarded(async () => (await plugin.request('flutter.openFile', { path: file })).message)

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: { subscriptions: unknown[] }): void {
  ctx.subscriptions.push(plugin.on('flutter.state', apply))
  void refreshDevices()
  void refreshEmulators()
}

function Action({ id, icon, children }: { id: string; icon: string; children: string }) {
  return (
    <Button variant="outline" icon={icon} disabled={read(busy)} onPress={() => void act(id)}>
      {children}
    </Button>
  )
}

function DebugSessions() {
  const current = read(session)
  const state = read(runState)
  return (
    <Stack gap="xs">
      <Row justify="between">
        <Heading>Debug Sessions</Heading>
        <Badge tone={TONES[state] ?? 'neutral'}>{state}</Badge>
      </Row>
      {current ? (
        <>
          <List label="Debug sessions">
            <ListItem icon="bug" title={current.title} description={current.device ?? 'default device'} current />
          </List>
          <Row gap="xs" wrap>
            <Action id="hotReload" icon="zap">Hot Reload</Action>
            <Action id="hotRestart" icon="refresh">Hot Restart</Action>
            <Action id="stop" icon="stop">Stop</Action>
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
            icon="file"
            title={d.name}
            description={d.platform}
            current={d.id === chosen}
            onPress={() => void pick(d.id)}
          />
        ))}
        {platforms.map((p) => (
          <ListItem key={p} icon="add" title={`Enable ${p} for this project`} onPress={() => void enablePlatform(p)} />
        ))}
      </List>
      <Row gap="xs">
        <Select
          label="Emulator"
          labelHidden
          placeholder="No emulators"
          value={read(emulator) ?? undefined}
          options={read(emulators).map((e) => ({ value: e.id, label: e.name }))}
          onChange={(id) => set(emulator, id)}
        />
        <IconButton icon="play" label="Launch emulator" disabled={!read(emulator)} onPress={() => void launchEmulator()} />
      </Row>
    </Stack>
  )
}

function DevTools() {
  const { extensions } = read(project)
  return (
    <Stack gap="xs">
      <Heading>DevTools</Heading>
      <List label="DevTools">
        {DEVTOOLS_PAGES.map((p) => (
          <ListItem key={p.id} icon={p.icon} title={p.title} onPress={() => void openDevTools(p.id)} />
        ))}
      </List>
      <Row gap="xs" wrap>
        <Action id="openSidebar" icon="layers">Open Sidebar</Action>
      </Row>
      {extensions.length > 0 ? (
        <>
          <Heading>DevTools Extensions</Heading>
          <List label="DevTools extensions">
            {extensions.map((name) => (
              <ListItem key={name} icon="puzzle" title={name} onPress={() => void openDevTools(`${name}_ext`)} />
            ))}
          </List>
        </>
      ) : null}
    </Stack>
  )
}

function Problems() {
  const list = read(problems)
  if (list === null) return null
  const shown = list.slice(0, MAX_PROBLEMS)
  return (
    <Stack gap="xs">
      <List label="Problems">
        {shown.map((p, i) => (
          <ListItem
            key={`${p.file}:${p.line}:${i}`}
            icon={SEVERITY_ICONS[p.severity] ?? 'info'}
            title={p.message}
            description={`${p.display}:${p.line}`}
            onPress={() => void openProblem(p.file)}
          />
        ))}
      </List>
      {list.length > shown.length ? <Text muted size="xs">{`${list.length - shown.length} more not shown.`}</Text> : null}
    </Stack>
  )
}

export default function Panel() {
  const last = read(result)
  return (
    <Stack gap="md">
      <DebugSessions />
      <Devices />
      <Row gap="xs" wrap>
        <Action id="run" icon="play">Run</Action>
        <Action id="runProfile" icon="gauge">Profile</Action>
        <Action id="runRelease" icon="rocket">Release</Action>
        <Action id="attach" icon="link">Attach</Action>
        <Action id="rerun" icon="refresh">Rerun</Action>
      </Row>

      <DevTools />
      <Row gap="xs" wrap>
        <Action id="inspectWidget" icon="search">Widget Inspector</Action>
        <Action id="debugPaint" icon="edit">Debug Paint</Action>
        <Action id="repaintRainbow" icon="edit">Repaint Rainbow</Action>
        <Action id="slowAnimations" icon="pause">Slow Animations</Action>
        <Action id="debugBanner" icon="flag">Debug Banner</Action>
        <Action id="paintBaselines" icon="code">Baselines</Action>
        <Action id="cancelInspectWidget" icon="close">Cancel Inspect</Action>
        <Action id="performanceOverlay" icon="activity">Perf Overlay</Action>
        <Action id="overridePlatform" icon="layers">Platform</Action>
        <Action id="toggleBrightness" icon="star">Brightness</Action>
        <Action id="screenshot" icon="download">Screenshot</Action>
        <Action id="dumpWidgets" icon="file-text">Widget Tree</Action>
        <Action id="dumpRenderTree" icon="file-text">Render Tree</Action>
      </Row>

      <Heading>Problems</Heading>
      <Row gap="xs" wrap>
        <Button variant="outline" icon="search" disabled={read(busy)} onPress={() => void analyze()}>
          Analyze
        </Button>
        <Action id="fixApply" icon="wrench">Dart Fix</Action>
        <Action id="format" icon="code">Dart Format</Action>
      </Row>
      <Problems />

      <Heading>Project</Heading>
      <Row gap="xs" wrap>
        <Action id="pubGet" icon="download">Pub Get</Action>
        <Action id="pubUpgrade" icon="upload">Pub Upgrade</Action>
        <Action id="pubOutdated" icon="info">Pub Outdated</Action>
        <Action id="pubAdd" icon="add">Pub Add</Action>
        <Action id="pubAddDev" icon="add">Pub Add (dev)</Action>
        <Action id="pubGetAll" icon="download">Get All</Action>
        <Action id="cleanAll" icon="delete">Clean All</Action>
        <Action id="dartdoc" icon="book">Dart Doc</Action>
        <Action id="buildRunner" icon="hammer">build_runner</Action>
        <Action id="genL10n" icon="globe">Gen L10n</Action>
        <Action id="clean" icon="delete">Clean</Action>
      </Row>

      <Heading>Tests</Heading>
      <Row gap="xs" wrap>
        <Action id="test" icon="check">Run Tests</Action>
        <Action id="testCoverage" icon="gauge">Coverage</Action>
      </Row>

      <Heading>SDK</Heading>
      <Row gap="xs" wrap>
        <Action id="doctor" icon="activity">Doctor</Action>
        <Action id="upgrade" icon="download">Upgrade</Action>
        <Action id="createProject" icon="add">Create Project</Action>
        <Action id="widgetPreview" icon="layers">Widget Preview</Action>
        <Action id="openInXcode" icon="code">Open in Xcode</Action>
        <Action id="openInAndroidStudio" icon="code">Open in Android Studio</Action>
        <Action id="copyVmServiceUri" icon="copy">Copy VM URI</Action>
        <Action id="copyDtdUri" icon="copy">Copy DTD URI</Action>
      </Row>

      {last ? <Text tone={last.tone}>{last.text}</Text> : null}
      <Text muted size="xs">
        Runs in the focused workspace. A project with .fvmrc uses fvm flutter and fvm dart (see the sdkMode setting).
      </Text>
    </Stack>
  )
}
