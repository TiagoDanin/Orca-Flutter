// Components panel: Orca draws these controls, so it follows the app theme with no HTML or CSS.
import { atom, Button, Heading, Row, Stack, Text, plugin, read, set } from 'orca'

const busy = atom(false)
const result = atom<{ tone: 'success' | 'danger'; text: string } | null>(null)

async function run(id: string): Promise<void> {
  set(busy, true)
  try {
    // The worker opens a terminal in the focused workspace, using `fvm flutter` when the project pins FVM.
    const { command } = await plugin.request('flutter.run', { id })
    set(result, { tone: 'success', text: `Opened a terminal: ${command}` })
  } catch (error) {
    set(result, { tone: 'danger', text: error instanceof Error ? error.message : String(error) })
  } finally {
    set(busy, false)
  }
}

function Action({ id, icon, children }: { id: string; icon: string; children: string }) {
  return (
    <Button variant="outline" icon={icon} disabled={read(busy)} onPress={() => void run(id)}>
      {children}
    </Button>
  )
}

export default function Panel() {
  const last = read(result)
  return (
    <Stack gap="md">
      <Heading>SDK</Heading>
      <Stack gap="xs">
        <Action id="doctor" icon="activity">Flutter Doctor</Action>
        <Action id="upgrade" icon="download">Flutter Upgrade</Action>
        <Action id="createProject" icon="add">Create Project</Action>
      </Stack>
      <Heading>Tests</Heading>
      <Stack gap="xs">
        <Action id="test" icon="check">Run Tests</Action>
        <Action id="testCoverage" icon="gauge">Run Tests with Coverage</Action>
      </Stack>
      {last ? <Text tone={last.tone}>{last.text}</Text> : null}
      <Text muted size="xs">
        Runs in the focused workspace. A project with .fvmrc uses fvm flutter.
      </Text>
    </Stack>
  )
}
