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

type Device = { id: string; name: string; platform: string }
type Emulator = { id: string; name: string; platform: string }
type Problem = { severity: string; code: string; file: string; line: number; message: string; display: string }
type Links = { devTools?: string; vmService?: string }
type Snapshot = { device: { id: string; name: string } | null; state: string; links: Links }

const MAX_PROBLEMS = 50

const devices = atom<Device[]>([])
const emulators = atom<Emulator[]>([])
const selected = atom<string | null>(null)
const emulator = atom<string | null>(null)
const runState = atom('idle')
const links = atom<Links>({})
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
  const state = read(runState)
  const last = read(result)
  const link = read(links)
  return (
    <Stack gap="md">
      <Row justify="between">
        <Heading>Run</Heading>
        <Badge tone={TONES[state] ?? 'neutral'}>{state}</Badge>
      </Row>
      <Row gap="xs">
        <Select
          label="Device"
          labelHidden
          placeholder="No device"
          value={read(selected) ?? undefined}
          options={read(devices).map((d) => ({ value: d.id, label: d.name }))}
          onChange={(id) => void pick(id)}
        />
        <IconButton icon="refresh" label="Refresh devices" onPress={() => void refreshDevices()} />
      </Row>
      <Row gap="xs" wrap>
        <Action id="run" icon="play">Run</Action>
        <Action id="stop" icon="stop">Stop</Action>
        <Action id="hotReload" icon="zap">Hot Reload</Action>
        <Action id="hotRestart" icon="refresh">Hot Restart</Action>
      </Row>
      <Row gap="xs" wrap>
        <Action id="runProfile" icon="gauge">Profile</Action>
        <Action id="runRelease" icon="rocket">Release</Action>
        <Action id="attach" icon="link">Attach</Action>
      </Row>

      <Heading>Debug</Heading>
      <Row gap="xs" wrap>
        <Action id="inspectWidget" icon="search">Widget Inspector</Action>
        <Action id="debugPaint" icon="edit">Debug Paint</Action>
        <Action id="performanceOverlay" icon="activity">Performance</Action>
        <Action id="overridePlatform" icon="layers">Platform</Action>
        <Action id="toggleBrightness" icon="star">Brightness</Action>
        <Action id="screenshot" icon="download">Screenshot</Action>
        <Action id="dumpWidgets" icon="file-text">Widget Tree</Action>
        <Action id="dumpRenderTree" icon="file-text">Render Tree</Action>
      </Row>
      <Row gap="xs" wrap>
        <Action id="openDevTools" icon="open-external">Open DevTools</Action>
        {link.devTools ? <Link href={link.devTools}>DevTools link</Link> : null}
        {link.vmService ? <Link href={link.vmService}>VM Service</Link> : null}
      </Row>

      <Heading>Emulators</Heading>
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
      </Row>

      {last ? <Text tone={last.tone}>{last.text}</Text> : null}
      <Text muted size="xs">
        Runs in the focused workspace. A project with .fvmrc uses fvm flutter and fvm dart (see the sdkMode setting).
      </Text>
    </Stack>
  )
}
