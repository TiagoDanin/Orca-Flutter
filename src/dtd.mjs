// Dart Tooling Daemon (DTD) and DevTools server, as Dart-Code uses them (shared/services/tooling_daemon.ts,
// extension/sdk/dev_tools/manager.ts). The editor sidebar and the property editor of DevTools are pages that talk to
// the `Editor` service an IDE registers in DTD. This file is that IDE side, minus the VS Code parts.
import { execFileSync, spawn } from 'node:child_process'

const EVENT_KINDS = [
  'activeLocationChanged',
  'deviceAdded',
  'deviceRemoved',
  'deviceChanged',
  'deviceSelected',
  'debugSessionStarted',
  'debugSessionChanged',
  'debugSessionStopped'
]
export const EDITOR_STREAM = 'Editor'

// `dart tooling-daemon --machine` prints {"tooling_daemon_details":{"uri":"ws://...","trusted_client_secret":"..."}}.
export function parseDtdLine(line) {
  try {
    const details = JSON.parse(line)?.tooling_daemon_details
    if (typeof details?.uri === 'string' && typeof details?.trusted_client_secret === 'string') {
      return { uri: details.uri, secret: details.trusted_client_secret }
    }
  } catch {
    // not json
  }
  return null
}

// `dart devtools --machine` prints {"event":"server.started","params":{"host":"127.0.0.1","port":9101}}.
export function parseDevToolsLine(line) {
  try {
    const message = JSON.parse(line)
    if (message?.event === 'server.started' && Number.isInteger(message.params?.port)) {
      return { host: String(message.params.host), port: message.params.port }
    }
  } catch {
    // not json
  }
  return null
}

// Kills a process and everything it started. Orca can stop the worker without running exit handlers, so callers
// also record pids and call killStale on the next start.
export function killTree(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return
  try {
    if (process.platform === 'win32') execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    else process.kill(-pid, 'SIGTERM')
  } catch {
    // already gone
  }
}

// Only kills a recorded pid that still runs one of our tools (the pid may have been reused since).
export function killStale(pids) {
  for (const pid of pids ?? []) {
    try {
      if (process.platform !== 'win32') {
        const command = execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf8' })
        if (!/tooling-daemon|devtools|widget-preview/.test(command)) continue
      }
      killTree(pid)
    } catch {
      // not running
    }
  }
}

// Runs a command line (built from constants and validated uris) and resolves with the first line `pick` accepts.
function spawnUntil(command, cwd, pick, timeoutMs = 30_000) {
  // Own process group (POSIX), so killTree reaches `dart` behind the shell and the `fvm` wrapper.
  const child = spawn(command, { cwd, shell: true, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] })
  const found = new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error(`Timed out starting: ${command}`)), timeoutMs)
    child.stdout.on('data', (chunk) => {
      buffer += chunk
      let at
      while ((at = buffer.indexOf('\n')) >= 0) {
        const value = pick(buffer.slice(0, at).trim())
        buffer = buffer.slice(at + 1)
        if (value) {
          clearTimeout(timer)
          resolve(value)
        }
      }
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`${command} exited with code ${code}`))
    })
    child.on('error', reject)
  })
  return { child, found }
}

// JSON-RPC 2.0 over a WebSocket. `handlers` answer requests DTD forwards for services we registered.
export class DtdClient {
  #socket
  #next = 1
  #pending = new Map()
  #handlers = new Map()
  #listeners = new Map()

  constructor(uri, secret) {
    this.uri = uri
    this.secret = secret
  }

  connect() {
    return new Promise((resolve, reject) => {
      const socket = (this.#socket = new WebSocket(this.uri))
      socket.addEventListener('open', () => resolve(this))
      socket.addEventListener('error', () => reject(new Error(`Could not connect to DTD at ${this.uri}`)))
      socket.addEventListener('message', (event) => void this.#onMessage(String(event.data)))
      socket.addEventListener('close', () => {
        for (const { reject: fail } of this.#pending.values()) fail(new Error('DTD connection closed'))
        this.#pending.clear()
      })
    })
  }

  get open() {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  #send(message) {
    if (!this.open) throw new Error('DTD connection is not open')
    this.#socket.send(JSON.stringify({ jsonrpc: '2.0', ...message }))
  }

  async #onMessage(data) {
    let json
    try {
      json = JSON.parse(data)
    } catch {
      return
    }
    if (json.method === 'streamNotify') {
      const { streamId, eventKind, eventData } = json.params ?? {}
      for (const fn of this.#listeners.get(`${streamId}.${eventKind}`) ?? []) fn(eventData)
    } else if (json.id !== undefined && json.method) {
      const handler = this.#handlers.get(json.method)
      if (!handler) return
      try {
        this.#send({ id: json.id, result: await handler(json.params ?? {}) })
      } catch (error) {
        const code = typeof error?.code === 'number' ? error.code : -32000
        try {
          this.#send({ id: json.id, error: { code, message: String(error?.message ?? error) } })
        } catch {
          // the connection dropped while handling
        }
      }
    } else if (json.id !== undefined) {
      const entry = this.#pending.get(String(json.id))
      if (!entry) return
      this.#pending.delete(String(json.id))
      if (json.error) entry.reject(new Error(json.error.message ?? 'DTD error'))
      else entry.resolve(json.result)
    }
  }

  call(method, params) {
    const id = String(this.#next++)
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      try {
        this.#send({ id, method, params })
      } catch (error) {
        this.#pending.delete(id)
        reject(error)
      }
    })
  }

  // Registers `Editor.<method>`; DTD then forwards calls of other clients (DevTools pages) to the handler.
  async registerService(service, method, handler, capabilities) {
    const result = await this.call('registerService', { service, method, capabilities })
    if (result?.type !== 'Success') throw new Error(`Could not register ${service}.${method}`)
    this.#handlers.set(`${service}.${method}`, handler)
  }

  // Tells DTD which events an Editor client posts (device and debug session changes, active location).
  postEvent(kind, data = {}) {
    if (!EVENT_KINDS.includes(kind) || !this.open) return
    this.#send({ method: 'postEvent', params: { streamId: EDITOR_STREAM, eventKind: kind, eventData: data } })
  }

  registerVmService(uri, name) {
    return this.call('ConnectedApp.registerVmService', { secret: this.secret, uri, name })
  }

  unregisterVmService(uri) {
    return this.call('ConnectedApp.unregisterVmService', { secret: this.secret, uri })
  }

  setWorkspaceRoots(roots) {
    return this.call('FileSystem.setIDEWorkspaceRoots', { secret: this.secret, roots })
  }

  close() {
    try {
      this.#socket?.close()
    } catch {
      // already closed
    }
  }
}

// Starts DTD, connects to it and starts the DevTools server that uses it (`--allow-embedding` lets pages be framed).
// `dart` is `dart` or `fvm dart`. Returns what is needed to build page urls, and `stop`.
export async function startTooling({ dart, cwd }) {
  const dtdProcess = spawnUntil(`${dart} tooling-daemon --machine`, cwd, parseDtdLine)
  let devTools
  try {
    const dtd = await dtdProcess.found
    const client = await new DtdClient(dtd.uri, dtd.secret).connect()
    // The uri is printed by Dart itself, but it ends up in a shell command, so check it first.
    if (!/^ws:\/\/127\.0\.0\.1:\d+\/[A-Za-z0-9_=+/-]*$/.test(dtd.uri)) throw new Error(`Unexpected DTD uri: ${dtd.uri}`)
    devTools = spawnUntil(`${dart} devtools --machine --allow-embedding --dtd-uri ${dtd.uri}`, cwd, parseDevToolsLine)
    const server = await devTools.found
    const pids = [dtdProcess.child.pid, devTools.child.pid]
    const stop = () => {
      client.close()
      pids.forEach(killTree)
    }
    return { client, dtd, baseUrl: `http://${server.host}:${server.port}/`, stop, pids }
  } catch (error) {
    killTree(dtdProcess.child.pid)
    killTree(devTools?.child.pid)
    throw error
  }
}

// A DevTools page url as Dart-Code builds it (manager.ts buildDevToolsUrl): path = page, query = uri and flags.
// `base` is the root of a DevTools server, or the link `flutter run` printed (it may end in /devtools/ behind a token).
export function pageUrl(base, page, { vmServiceUri, dtdUri, embed = false, ide = false } = {}) {
  if (typeof base !== 'string' || !/^[A-Za-z0-9_-]+$/.test(page)) return null
  let url
  try {
    url = new URL(base)
  } catch {
    return null
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname += '/'
  url.pathname += page
  if (vmServiceUri) url.searchParams.set('uri', vmServiceUri)
  if (dtdUri) url.searchParams.set('dtdUri', dtdUri)
  // Dart-Code getDefaultQueryParams: `ide` is the legacy name, dashTool and dashIdeName the new ones.
  if (ide) {
    url.searchParams.set('ide', 'VSCode')
    url.searchParams.set('dashTool', 'orca')
    url.searchParams.set('dashIdeName', 'Orca')
  }
  if (embed) {
    url.searchParams.set('embed', 'true')
    url.searchParams.set('embedMode', 'one')
  }
  return url.toString()
}
