import { exec, execFile, spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import {
  DEVTOOLS_PAGES,
  detectState,
  extractLinks,
  isInside,
  enablablePlatforms,
  packageRoots,
  parseExtensionName,
  PLATFORMS,
  parseAnalyze,
  parseDevices,
  parseEmulators,
  validDeviceId
} from './run.mjs'
import { killStale, killTree, pageUrl, startTooling } from './dtd.mjs'
import { cancelInspect, toggle as toggleVm, vmWsUrl } from './vm.mjs'
import { dartCommand, flutterCommand, SDK_MODES } from './sdk.mjs'
import { launchConfigurations as parseLaunchConfigurations, runCommandText } from './launch.mjs'

const execAsync = promisify(exec)
const execFileAsync = promisify(execFile)

// The `orca` CLI opens a browser tab inside Orca (`orca tab create`). Where it lives depends on the install.
const ORCA_CLIS = [process.env.ORCA_CLI, '/Applications/Orca.app/Contents/Resources/bin/orca', 'orca'].filter(Boolean)

// Tab titles like the Dart-Code views: "Flutter DevTools: Inspector", extensions by name.
const pageTitle = (page) => {
  const known = DEVTOOLS_PAGES.find((p) => p.id === page)
  return `Flutter DevTools: ${known ? known.title.replace(/^Flutter /, '') : page.replace(/_ext$/, '')}`
}

// Pages DevTools can show without a running app (Dart-Code isStaticTool).
const STATIC_PAGES = ['deep-links']

// Runs the orca CLI (see ORCA_CLIS) and returns its stdout.
async function orcaCli(args) {
  let last
  for (const cli of ORCA_CLIS) {
    try {
      return (await execFileAsync(cli, args, { timeout: 20_000, windowsHide: true })).stdout
    } catch (error) {
      last = error
    }
  }
  throw last ?? new Error('orca CLI not found')
}

// A browser tab shows the page title, and DevTools pages have none (the tab would show the url). Waits for the
// page to load, then sets the title and keeps it when the page tries to change it.
async function titleTab(pageId, worktree, title) {
  const where = worktree ? ['--worktree', `path:${worktree}`] : []
  for (let i = 0; i < 40; i++) {
    await new Promise((resolve) => setTimeout(resolve, 750))
    const tabs = JSON.parse(await orcaCli(['tab', 'list', ...where, '--json'])).result?.tabs ?? []
    const tab = tabs.find((t) => t.browserPageId === pageId)
    if (!tab) return // closed meanwhile
    if (!tab.loaded) continue
    if (!tab.active) await orcaCli(['tab', 'switch', '--page', pageId, ...where])
    const expression = `(() => { const t = ${JSON.stringify(title)}; const set = () => { if (document.title !== t) document.title = t }; set(); new MutationObserver(set).observe(document.head, { childList: true, subtree: true, characterData: true }) })()`
    await orcaCli(['eval', '--expression', expression, ...where])
    return
  }
}

// `worktree` is the workspace folder: without it Orca uses the worktree of the calling process, which is not ours.
// `title` names the tab; it is set after the page loads, without making the caller wait.
export async function openOrcaTab(url, { split, worktree, title } = {}) {
  const args = ['tab', 'create', '--url', url, '--json', ...(split ? ['--split', split] : []), ...(worktree ? ['--worktree', `path:${worktree}`] : [])]
  let out
  try {
    out = await orcaCli(args)
  } catch (error) {
    throw new Error(`Could not open a tab in Orca (${error?.message ?? 'orca CLI not found'}). Open ${url} in a browser.`)
  }
  const id = JSON.parse(out).result?.browserPageId
  if (title && id) void titleTab(id, worktree, title).catch(() => {})
}

// Long-running sessions. All of them accept r, R and q in their terminal.
const RUN_KINDS = {
  run: { title: 'Flutter: Run', args: 'run', mode: 'debug' },
  runProfile: { title: 'Flutter: Run (Profile)', args: 'run --profile', mode: 'profile' },
  runRelease: { title: 'Flutter: Run (Release)', args: 'run --release', mode: 'release' },
  attach: { title: 'Flutter: Attach', args: 'attach', mode: 'debug' }
}

// The sdkMode setting: `auto` follows the project's FVM pin, `fvm` and `flutter` force one.
export async function sdkMode(orca) {
  const mode = await orca.settings.get('sdkMode')
  return SDK_MODES.includes(mode) ? mode : 'auto'
}

async function focusedWorkspace(orca) {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx?.workspaceId) throw new Error('Focus a workspace first')
  const { workspaces } = await orca.host.call('workspace.list', {})
  const ws = workspaces.find((w) => w.id === ctx.workspaceId)
  // shortcut: FVM is detected only on this machine; SSH and runtime workspaces use plain `flutter`. Revisit with remote support.
  const path = !ws?.hostId || ws.hostId === 'local' ? (ws?.path ?? null) : null
  const mode = await sdkMode(orca)
  return { id: ctx.workspaceId, path, flutter: flutterCommand(path, mode), dart: dartCommand(path, mode) }
}

// With enter: false the command is typed but not run, so the user can finish it (e.g. the project name).
async function openTerminal(orca, workspaceId, title, text, { enter = true } = {}) {
  const params = { workspaceId, title }
  const { terminalId } = await orca.host.call('terminal.create', enter ? { ...params, command: text } : params)
  if (!enter) await orca.host.call('terminal.sendText', { terminalId, text, enter: false })
  await orca.host.call('terminal.focus', { terminalId })
  return terminalId
}

// The command is built only from constants (`flutter`, `fvm flutter`, `dart`, `fvm dart` and fixed arguments),
// so running it through the shell is safe. Used for quick commands whose output the worker reads.
function runHere(command, ws, { timeout = 60_000 } = {}) {
  if (!ws.path) throw new Error('This needs a local workspace')
  return execAsync(command, { cwd: ws.path, timeout, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
}

// One Flutter run per plugin: the selected device and the terminal running `flutter run`.
// onChange fires whenever either changes, so the status bar and the panel can redraw.
export function createSession(orca, onChange) {
  let device = null // { id, name }
  let run = null // { terminalId, state, links: { devTools?, vmService? } }

  const snapshot = () => ({
    device,
    configuration,
    state: run?.state ?? 'idle',
    links: run?.links ?? {},
    session: run ? { title: run.title, device: run.device } : null
  })
  const setRun = (next) => {
    run = next
    onChange()
    void syncTooling()
  }
  let tooling = null // Promise of { client, dtd, baseUrl, root, stop }: DTD + DevTools server, started on first use
  let preview = null // { child, url } of `flutter widget-preview start`
  let lastKind = 'run' // for Rerun
  let configuration = null // name of the .vscode/launch.json entry Run appends args from
  let announced = '' // the debug session last sent to DTD, to send only changes
  let registeredVm = null

  // Orca can stop the worker without a chance to clean up, so the pids of what we started are kept and killed next time.
  const rememberPids = (pids) => orca.storage.set('pids', pids.filter(Boolean))

  async function init() {
    killStale(await orca.storage.get('pids'))
    await orca.storage.set('pids', [])
    const storedConfiguration = await orca.storage.get('configuration')
    // A name is only a pick: it is resolved against launch.json on every run, so edits apply.
    if (typeof storedConfiguration === 'string' && storedConfiguration !== '') configuration = storedConfiguration
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
    const { stdout } = await runHere(`${ws.flutter} devices --machine`, ws)
    return parseDevices(stdout)
  }

  // The Dart and Flutter entries of the workspace's .vscode/launch.json, with their preLaunchTask command.
  async function launchList() {
    const ws = await focusedWorkspace(orca)
    if (!ws.path) return []
    const read = (file) => {
      try {
        return readFileSync(join(ws.path, '.vscode', file), 'utf8')
      } catch {
        return null
      }
    }
    return parseLaunchConfigurations(read('launch.json'), read('tasks.json'))
  }

  async function configurations() {
    return { configurations: await launchList(), selected: configuration }
  }

  async function selectConfiguration(name) {
    const found = (await launchList()).find((c) => c.name === name)
    if (!found) throw new Error(`Launch configuration not found: ${name}`)
    configuration = found.name
    await orca.storage.set('configuration', configuration)
    onChange()
    return `Configuration: ${configuration}`
  }

  async function choose(next) {
    device = { id: next.id, name: next.name }
    await orca.storage.set('device', device)
    onChange()
    void syncTooling()
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

  async function emulators() {
    const ws = await focusedWorkspace(orca)
    const { stdout } = await runHere(`${ws.flutter} emulators`, ws)
    return parseEmulators(stdout)
  }

  async function launchEmulator(id) {
    if (!validDeviceId(id)) throw new Error(`Invalid emulator id: ${id}`)
    return runCommand({ tool: 'flutter', title: 'Flutter: Launch Emulator', args: `emulators --launch ${id}` })
  }

  async function startRun(kindId = 'run') {
    const kind = RUN_KINDS[kindId]
    lastKind = kindId
    if (run) {
      try {
        await orca.host.call('terminal.focus', { terminalId: run.terminalId })
        return 'Already running: showing its terminal'
      } catch {
        run = null // the terminal was closed
      }
    }
    const ws = await focusedWorkspace(orca)
    const chosen = configuration ? (await launchList()).find((c) => c.name === configuration) : null
    if (configuration && !chosen) orca.log(`Launch configuration not found: ${configuration}`)
    const text = runCommandText(`${ws.flutter} ${kind.args}`, chosen?.args ?? [], chosen?.preCommand ?? null, device?.id)
    const terminalId = await openTerminal(orca, ws.id, kind.title, text)
    setRun({ terminalId, state: 'starting', links: {}, title: kind.title.replace('Flutter: ', ''), device: device?.name ?? null, mode: kind.mode, root: ws.path })
    return text
  }

  // Flutter reads single keys from its terminal (r reload, R restart, q quit, p debug paint, v DevTools...).
  async function sendKey(text, state) {
    if (!run) throw new Error('Nothing is running. Run the app first.')
    await orca.host.call('terminal.sendText', { terminalId: run.terminalId, text, enter: false })
    if (state) setRun({ ...run, state })
    return `Sent "${text}" to flutter run`
  }

  // `dart analyze` exits non-zero when it finds problems, but the report is still on stdout.
  async function analyze() {
    const ws = await focusedWorkspace(orca)
    let stdout
    try {
      ;({ stdout } = await runHere(`${ws.dart} analyze --format=machine`, ws, { timeout: 120_000 }))
    } catch (error) {
      if (typeof error.stdout !== 'string' || error.stdout === '') throw error
      stdout = error.stdout
    }
    const problems = parseAnalyze(stdout).map((p) => ({ ...p, display: relative(ws.path, p.file).replaceAll('\\', '/') }))
    return { problems }
  }

  // The panel sends the path, so only files inside the focused workspace are opened.
  async function openFile(file) {
    const ws = await focusedWorkspace(orca)
    if (!ws.path || typeof file !== 'string' || !isInside(ws.path, file)) {
      throw new Error('That file is not in the focused workspace')
    }
    const shown = relative(ws.path, file).replaceAll('\\', '/')
    // shortcut: the docs do not say whether editor.open takes an absolute or a workspace-relative path; try both.
    try {
      await orca.host.call('editor.open', { workspaceId: ws.id, path: file })
    } catch {
      await orca.host.call('editor.open', { workspaceId: ws.id, path: shown })
    }
    return `Opened ${shown}`
  }

  // Platforms the project lacks ("Enable web for this project") and DevTools extensions shipped by its packages.
  async function project(platformTypes = []) {
    const ws = await focusedWorkspace(orca)
    if (!ws.path || !existsSync(join(ws.path, 'pubspec.yaml'))) return { platforms: [], extensions: [] }
    const present = readdirSync(ws.path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)
    const extensions = []
    try {
      const dir = join(ws.path, '.dart_tool')
      for (const root of packageRoots(readFileSync(join(dir, 'package_config.json'), 'utf8'), dir)) {
        try {
          const name = parseExtensionName(readFileSync(join(root, 'extension', 'devtools', 'config.yaml'), 'utf8'))
          if (name && !extensions.includes(name)) extensions.push(name)
        } catch {
          // package without an extension
        }
      }
    } catch {
      // no package_config.json yet: pub get has not run
    }
    return { platforms: enablablePlatforms(present, Array.isArray(platformTypes) ? platformTypes : []), extensions: extensions.sort() }
  }

  // Same steps as Dart-Code enablePlatformType: `flutter config --enable-<p>` if it is set to false,
  // then `flutter create --platforms <p> --empty .` in the project.
  async function enablePlatform(platform) {
    if (!PLATFORMS.includes(platform)) throw new Error(`Unknown platform: ${platform}`)
    const ws = await focusedWorkspace(orca)
    try {
      const { stdout } = await runHere(`${ws.flutter} config --machine`, ws)
      if (JSON.parse(stdout.slice(stdout.indexOf('{')))[`enable-${platform}`] === false) {
        await runHere(`${ws.flutter} config --enable-${platform}`, ws)
      }
    } catch {
      // keep going: create will say if the platform is unavailable
    }
    return runCommand({ tool: 'flutter', title: `Flutter: Enable ${platform}`, args: `create --platforms ${platform} --empty .` })
  }

  // The Editor service DevTools pages (editor sidebar, property editor) call, as in Dart-Code tooling_daemon.ts.
  const debugSessions = () =>
    run
      ? [
          {
            id: 'flutter-run',
            name: run.title,
            // DTD only accepts the websocket form (http://... gives "Connection failed").
            vmServiceUri: run.links.vmService ? (vmWsUrl(run.links.vmService) ?? undefined) : undefined,
            flutterMode: run.mode,
            flutterDeviceId: device?.id,
            debuggerType: 'Flutter',
            projectRootPath: run.root
          }
        ]
      : []

  async function editorDevices(ws) {
    const present = new Set(readdirSync(ws.path, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name))
    const hasProject = existsSync(join(ws.path, 'pubspec.yaml'))
    return (await devices()).map((d) => ({
      id: d.id,
      name: d.name,
      platform: d.platform,
      platformType: d.platformType ?? undefined,
      category: { android: 'mobile', ios: 'mobile', web: 'web' }[d.platformType] ?? 'desktop',
      emulator: /^emulator-|simulator/i.test(d.id) || /gphone|sdk |simulator/i.test(d.name),
      ephemeral: false,
      supported: !hasProject || !d.platformType || present.has(d.platformType)
    }))
  }

  async function registerEditor(t, ws) {
    const { client } = t
    const ok = { type: 'Success' }
    await Promise.all([
      client.registerService('Editor', 'getDevices', async () => ({
        type: 'GetDevicesResult',
        devices: await editorDevices(ws),
        selectedDeviceId: device?.id
      })),
      client.registerService('Editor', 'getDebugSessions', () => ({ type: 'GetDebugSessionsResult', debugSessions: debugSessions() })),
      // shortcut: Orca gives plugins no cursor events, so there is no active location for the property editor.
      client.registerService('Editor', 'getActiveLocation', () => ({ type: 'ActiveLocation', selections: [] })),
      client.registerService('Editor', 'selectDevice', async ({ deviceId }) => {
        if (typeof deviceId === 'string') await selectDevice(deviceId)
        return ok
      }),
      client.registerService('Editor', 'enablePlatformType', async ({ platformType }) => {
        await enablePlatform(platformType)
        return ok
      }),
      client.registerService('Editor', 'hotReload', async () => (await sendKey('r', 'reloading'), ok)),
      client.registerService('Editor', 'hotRestart', async () => (await sendKey('R', 'restarting'), ok)),
      client.registerService('Editor', 'navigateToCode', async ({ uri }) => {
        if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('Unsupported URI scheme')
        await openFile(fileURLToPath(uri))
        return ok
      }),
      client.registerService(
        'Editor',
        'openDevToolsPage',
        async (params) => (await openDevToolsPage(params), ok),
        { supportsForceExternal: true }
      )
    ])
    // Lets DevTools find the project's packages and their DevTools extensions.
    await client.setWorkspaceRoots([pathToFileURL(ws.path).toString()])
  }

  // DTD and the DevTools server are tied to a workspace (its roots decide which extensions DevTools finds),
  // so a different focused workspace gets its own.
  async function ensureTooling() {
    const ws = await focusedWorkspace(orca)
    if (!ws.path) throw new Error('DevTools needs a local workspace')
    if (tooling) {
      const current = await tooling.catch(() => null)
      if (current?.root === ws.path && current.client.open) return current
      current?.stop()
      tooling = null
      announced = ''
      registeredVm = null
    }
    tooling = (async () => {
      const t = await startTooling({ dart: ws.dart, cwd: ws.path })
      await rememberPids(t.pids)
      try {
        await registerEditor(t, ws)
      } catch (error) {
        t.stop()
        throw error
      }
      return { ...t, root: ws.path }
    })().catch((error) => {
      tooling = null
      throw error
    })
    return tooling
  }

  // Tells DTD about the selected device and the debug session, so the sidebar and DevTools follow them.
  async function syncTooling() {
    if (!tooling) return
    let t
    try {
      t = await tooling
    } catch {
      return
    }
    const state = JSON.stringify({ d: device?.id, s: debugSessions() })
    if (state === announced) return
    const before = announced ? JSON.parse(announced) : { s: [] }
    announced = state
    t.client.postEvent('deviceSelected', { deviceId: device?.id })
    const [now] = debugSessions()
    const [was] = before.s
    if (now && !was) t.client.postEvent('debugSessionStarted', { debugSession: now })
    else if (now) t.client.postEvent('debugSessionChanged', { debugSession: now })
    else if (was) t.client.postEvent('debugSessionStopped', { debugSessionId: was.id })
    const vm = now?.vmServiceUri ?? null
    if (vm !== registeredVm) {
      const old = registeredVm
      registeredVm = vm
      if (old) await t.client.unregisterVmService(old).catch(() => {})
      if (vm) await t.client.registerVmService(vm, now.name).catch((e) => orca.log(String(e?.message ?? e)))
    }
  }

  async function openSidebar() {
    const t = await ensureTooling()
    await openOrcaTab(pageUrl(t.baseUrl, 'editorSidebar', { ide: true }), { split: 'right', worktree: t.root, title: 'Flutter Sidebar' })
    return 'Opened the Flutter sidebar'
  }

  // `page` is a DevTools route: inspector, memory, ..., or <extension>_ext.
  async function openDevToolsPage({ page = 'inspector', debugSessionId, requiresDebugSession } = {}) {
    if (typeof page !== 'string' || !/^[A-Za-z0-9_-]+$/.test(page)) throw new Error(`Invalid DevTools page: ${String(page)}`)
    const t = await ensureTooling()
    const vm = STATIC_PAGES.includes(page) || !run?.links.vmService ? undefined : (vmWsUrl(run.links.vmService) ?? undefined)
    if (requiresDebugSession && !vm) throw new Error('Run the app first')
    void debugSessionId
    await openOrcaTab(pageUrl(t.baseUrl, page, { vmServiceUri: vm }), { worktree: t.root, title: pageTitle(page) })
    return `Opened DevTools ${page}`
  }

  // Dart-Code widget_preview_server.ts: the preview is served by `flutter widget-preview start --machine --web-server`
  // wired to the same DTD and DevTools server, and shown in a view instead of Chrome.
  async function widgetPreview() {
    if (preview && preview.child.exitCode === null) {
      await openOrcaTab(preview.url, { worktree: preview.root, title: 'Flutter Widget Preview' })
      return 'Opened the widget preview'
    }
    const ws = await focusedWorkspace(orca)
    const t = await ensureTooling()
    const args = `widget-preview start --machine --web-server --dtd-url ${t.dtd.uri} --devtools-server-address ${t.baseUrl}`
    const child = spawn(`${ws.flutter} ${args}`, { cwd: ws.path, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
    await rememberPids([...((await orca.storage.get('pids')) ?? []), child.pid])
    const url = await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error('The widget preview did not start in 3 minutes')), 180_000)
      child.stdout.on('data', (chunk) => {
        buffer += chunk
        let at
        while ((at = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, at).trim()
          buffer = buffer.slice(at + 1)
          try {
            for (const event of JSON.parse(line)) {
              if (event.event === 'widget_preview.started' && typeof event.params?.url === 'string') {
                clearTimeout(timer)
                resolve(event.params.url)
              }
            }
          } catch {
            // build output, not an event
          }
        }
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        reject(new Error(`flutter widget-preview exited with code ${code}`))
      })
    }).catch((error) => {
      killTree(child.pid)
      throw error
    })
    preview = { child, url, root: ws.path }
    await openOrcaTab(url, { worktree: ws.path, title: 'Flutter Widget Preview' })
    return 'Opened the widget preview'
  }

  // Flutter service extensions (repaint rainbow, slow animations...) have no key in `flutter run`, so they go
  // through the VM service like Dart-Code does.
  async function vm(name) {
    const uri = run?.links.vmService
    if (!uri) throw new Error('Nothing is running. Run the app first.')
    if (name === 'cancelInspectWidget') {
      await cancelInspect(uri)
      return 'Widget inspection off'
    }
    return `${name}: ${await toggleVm(uri, name)}`
  }

  // Dart-Code dart.rerunLastDebugSession: stop the run (if any) and start the same kind again.
  async function rerun() {
    if (run) {
      await sendKey('q')
      for (let i = 0; i < 20 && run; i++) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        await tick()
      }
      if (run) throw new Error('The run did not stop. Stop it and run again.')
    }
    return startRun(lastKind)
  }

  async function copyUri(what) {
    const value = what === 'dtd' ? (await ensureTooling()).dtd.uri : run?.links.vmService
    if (!value) throw new Error(what === 'dtd' ? 'No DTD' : 'No VM service. Run the app first.')
    const tool = { darwin: ['pbcopy', []], win32: ['clip', []] }[process.platform] ?? ['xclip', ['-selection', 'clipboard']]
    await new Promise((resolve, reject) => {
      const child = spawn(tool[0], tool[1], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
      child.on('error', reject)
      child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${tool[0]} exited with ${code}`))))
      child.stdin.end(value)
    })
    return `Copied ${value}`
  }

  // Folders with a pubspec.yaml under the workspace, up to 3 levels deep (Dart-Code projectSearchDepth is 5).
  function projectFolders(root, depth = 3) {
    const skip = new Set(['node_modules', 'build', 'ios', 'android', 'macos', 'linux', 'windows', 'web', 'submodules'])
    const found = []
    const walk = (dir, level) => {
      if (existsSync(join(dir, 'pubspec.yaml'))) found.push(dir)
      if (level >= depth) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory() && !entry.name.startsWith('.') && !skip.has(entry.name)) walk(join(dir, entry.name), level + 1)
      }
    }
    walk(root, 0)
    return found
  }

  const isFlutterProject = (dir) => /^\s+sdk:\s*flutter\s*$/m.test(readFileSync(join(dir, 'pubspec.yaml'), 'utf8'))

  // Dart-Code flutter.packages.get.all and flutter.clean.all.
  async function allProjects(task) {
    const ws = await focusedWorkspace(orca)
    if (!ws.path) throw new Error('This needs a local workspace')
    const projects = projectFolders(ws.path).filter(isFlutterProject)
    if (projects.length === 0) throw new Error('No Flutter projects found in this workspace')
    const args = task === 'clean' ? 'clean' : 'pub get'
    const failed = []
    for (const dir of projects) {
      try {
        await execAsync(`${ws.flutter} ${args}`, { cwd: dir, timeout: 300_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true })
      } catch {
        failed.push(basename(dir))
      }
    }
    const done = projects.length - failed.length
    if (failed.length) throw new Error(`flutter ${args} failed in: ${failed.join(', ')} (${done} ok)`)
    return `flutter ${args}: ${done} project${done === 1 ? '' : 's'}`
  }

  // Dart-Code flutter.openInXcode: the iOS workspace, else the macOS one.
  async function openInXcode() {
    if (process.platform !== 'darwin') throw new Error('Xcode is only available on macOS')
    const ws = await focusedWorkspace(orca)
    const target = ['ios', 'macos'].map((p) => join(ws.path ?? '', p, 'Runner.xcworkspace')).find((p) => existsSync(p))
    if (!target) throw new Error('No ios/Runner.xcworkspace or macos/Runner.xcworkspace in this workspace')
    await execFileAsync('open', [target])
    return `Opened ${relative(ws.path, target)}`
  }

  // Dart-Code flutter.openInAndroidStudio, with the Android Studio `flutter config` knows about.
  async function openInAndroidStudio() {
    const ws = await focusedWorkspace(orca)
    const android = join(ws.path ?? '', 'android')
    if (!existsSync(android)) throw new Error('No android folder in this workspace')
    const { stdout } = await runHere(`${ws.flutter} config --machine`, ws)
    const dir = JSON.parse(stdout.slice(stdout.indexOf('{')))['android-studio-dir']
    if (typeof dir !== 'string') throw new Error('Android Studio not found. Run: flutter config --android-studio-dir <path>')
    if (process.platform === 'darwin') await execFileAsync('open', ['-a', dirname(dir), android])
    else {
      const studio = join(dir, 'bin', process.platform === 'win32' ? 'studio64.exe' : 'studio.sh')
      if (!existsSync(studio)) throw new Error(`Android Studio not found at ${studio}`)
      // The IDE runs until the user closes it, so start it detached instead of waiting for it to exit.
      const child = spawn(studio, [android], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    }
    return 'Opened android in Android Studio'
  }

  function dispose() {
    if (preview) killTree(preview.child.pid)
    tooling?.then((t) => t.stop()).catch(() => {})
  }

  async function tick() {
    if (!run) return
    try {
      const { lines } = await orca.host.call('terminal.read', { terminalId: run.terminalId, maxLines: 60 })
      const state = detectState(lines)
      const links = { ...run.links, ...extractLinks(lines) }
      if (state === 'idle') setRun(null)
      else if ((state && state !== run.state) || JSON.stringify(links) !== JSON.stringify(run.links)) {
        setRun({ ...run, state: state ?? run.state, links })
      }
    } catch {
      setRun(null) // the terminal is gone
    }
  }

  return {
    init,
    snapshot,
    runCommand,
    devices,
    launchConfigurations: configurations,
    selectConfiguration,
    selectDevice,
    nextDevice,
    emulators,
    launchEmulator,
    startRun,
    sendKey,
    analyze,
    openFile,
    project,
    enablePlatform,
    widgetPreview,
    openSidebar,
    openDevToolsPage,
    vm,
    rerun,
    copyUri,
    allProjects,
    openInXcode,
    openInAndroidStudio,
    dispose,
    tick
  }
}
