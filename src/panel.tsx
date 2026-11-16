// Components panel: Orca draws these controls, so it follows the app theme with no HTML or CSS.
import { atom, Badge, Button, Heading, IconButton, Row, Select, Stack, Text, plugin, read, set } from 'orca'

type Device = { id: string; name: string; platform: string }
type Snapshot = { device: { id: string; name: string } | null; state: string }

const devices = atom<Device[]>([])
const selected = atom<string | null>(null)
const runState = atom('idle')
const busy = atom(false)
const result = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)

const TONES: Record<string, 'neutral' | 'warning' | 'success'> = {
  idle: 'neutral',
  starting: 'warning',
  running: 'success',
  reloading: 'warning',
  restarting: 'warning'
}

function show(error: unknown): void {
  set(result, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
}

function apply(snapshot: Snapshot): void {
  set(runState, snapshot.state)
  set(selected, snapshot.device?.id ?? null)
}

async function act(id: string): Promise<void> {
  set(busy, true)
  try {
    // The worker opens a terminal in the focused workspace, using `fvm flutter` when the project pins FVM.
    const { message } = await plugin.request('flutter.do', { id })
    set(result, { tone: 'success', text: message })
  } catch (error) {
    show(error)
  } finally {
    set(busy, false)
  }
}

async function refreshDevices(): Promise<void> {
  try {
    const { devices: list, ...snapshot } = await plugin.request('flutter.devices', {}, { timeoutMs: 60000 })
    set(devices, list)
    apply(snapshot)
    set(result, list.length === 0 ? { tone: 'danger', text: 'No devices found. Start an emulator or connect a device.' } : null)
  } catch (error) {
    show(error)
  }
}

async function pick(id: string): Promise<void> {
  try {
    const { message } = await plugin.request('flutter.selectDevice', { id }, { timeoutMs: 60000 })
    set(result, { tone: 'success', text: message })
  } catch (error) {
    show(error)
  }
}

/** Runs once before the first render; what it pushes to `subscriptions` ends with the panel. */
export function setup(ctx: { subscriptions: unknown[] }): void {
  ctx.subscriptions.push(plugin.on('flutter.state', apply))
  void refreshDevices()
}

function Action({ id, icon, children }: { id: string; icon: string; children: string }) {
  return (
    <Button variant="outline" icon={icon} disabled={read(busy)} onPress={() => void act(id)}>
      {children}
    </Button>
  )
}

export default function Panel() {
  const state = read(runState)
  const last = read(result)
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
      <Heading>Project</Heading>
      <Stack gap="xs">
        <Action id="pubGet" icon="download">Pub Get</Action>
        <Action id="buildRunner" icon="hammer">build_runner</Action>
        <Action id="clean" icon="delete">Clean</Action>
      </Stack>
      <Heading>Tests</Heading>
      <Stack gap="xs">
        <Action id="test" icon="check">Run Tests</Action>
        <Action id="testCoverage" icon="gauge">Run Tests with Coverage</Action>
      </Stack>
      <Heading>SDK</Heading>
      <Stack gap="xs">
        <Action id="doctor" icon="activity">Flutter Doctor</Action>
        <Action id="upgrade" icon="download">Flutter Upgrade</Action>
        <Action id="createProject" icon="add">Create Project</Action>
      </Stack>
      {last ? <Text tone={last.tone}>{last.text}</Text> : null}
      <Text muted size="xs">
        Runs in the focused workspace. A project with .fvmrc uses fvm flutter and fvm dart.
      </Text>
    </Stack>
  )
}
