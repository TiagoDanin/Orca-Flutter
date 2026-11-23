// Flutter service extensions over the Dart VM service, for the toggles `flutter run` has no key for.
// Same extensions and values as Dart-Code (extension/flutter/vm_service_extensions.ts, shared/enums.ts).

// name: the panel and command id. first: the value picked when the current one is not it; second: the other.
export const TOGGLES = {
  repaintRainbow: { method: 'ext.flutter.repaintRainbow', key: 'enabled', first: true, second: false },
  slowAnimations: { method: 'ext.flutter.timeDilation', key: 'timeDilation', first: 1, second: 5 },
  debugBanner: { method: 'ext.flutter.debugAllowBanner', key: 'enabled', first: true, second: false },
  paintBaselines: { method: 'ext.flutter.debugPaintBaselinesEnabled', key: 'enabled', first: true, second: false }
}

// The VM service uri `flutter run` prints is http://127.0.0.1:PORT/TOKEN=/ ; the socket is the same path + ws.
// The uri is read from the terminal, where the app's own output also lands, so only this machine is accepted.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]'])

export function vmWsUrl(uri) {
  try {
    const url = new URL(uri)
    if (!LOOPBACK.has(url.hostname)) return null
    if (url.protocol === 'http:') url.protocol = 'ws:'
    else if (url.protocol === 'https:') url.protocol = 'wss:'
    else if (url.protocol !== 'ws:' && url.protocol !== 'wss:') return null
    if (!url.pathname.endsWith('/ws')) url.pathname = `${url.pathname.replace(/\/$/, '')}/ws`
    url.search = ''
    return url.toString()
  } catch {
    return null
  }
}

// Extension answers are strings: {"enabled":"true"} or {"timeDilation":"1.0"}.
export function extractValue(raw) {
  if (raw === 'true') return true
  if (raw === 'false') return false
  const number = Number(raw)
  return raw !== '' && raw !== null && raw !== undefined && !Number.isNaN(number) ? number : raw
}

export const nextValue = ({ first, second }, current) => (current !== first ? first : second)

// One short connection per call: nothing to keep alive and nothing to clean up after a hot restart.
export function createVmClient(uri) {
  const url = vmWsUrl(uri)
  if (!url) return Promise.reject(new Error('No VM service. Run the app first.'))
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url)
    let next = 1
    const pending = new Map()
    socket.addEventListener('error', () => reject(new Error(`Could not connect to the VM service at ${url}`)))
    // A call in flight when the socket drops would otherwise wait for the panel's timeout.
    socket.addEventListener('close', () => {
      for (const { reject: fail } of pending.values()) fail(new Error('VM service connection closed'))
      pending.clear()
    })
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(message.error.message ?? 'VM service error'))
      else entry.resolve(message.result)
    })
    socket.addEventListener('open', () =>
      resolve({
        call: (method, params = {}) =>
          new Promise((ok, fail) => {
            const id = next++
            pending.set(id, { resolve: ok, reject: fail })
            socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
          }),
        close: () => socket.close()
      })
    )
  })
}

// The isolate that registered the extension (the UI isolate of a Flutter app).
async function isolateFor(client, method) {
  const vm = await client.call('getVM')
  for (const { id } of vm.isolates ?? []) {
    const isolate = await client.call('getIsolate', { isolateId: id })
    if (isolate.extensionRPCs?.includes(method)) return id
  }
  throw new Error(`${method} is not available in this app (is it running in debug or profile mode?)`)
}

export async function callExtension(uri, method, params) {
  const client = await createVmClient(uri)
  try {
    return await client.call(method, { isolateId: await isolateFor(client, method), ...params })
  } finally {
    client.close()
  }
}

// Reads the current value, then sends the other one. Returns what was set.
export async function toggle(uri, name) {
  const spec = TOGGLES[name]
  if (!spec) throw new Error(`Unknown toggle: ${name}`)
  const current = extractValue((await callExtension(uri, spec.method))?.[spec.key])
  const value = nextValue(spec, current)
  await callExtension(uri, spec.method, { [spec.key]: value })
  return value
}

// Dart-Code flutter.cancelInspectWidget: turns the widget selection mode off.
export const cancelInspect = (uri) => callExtension(uri, 'ext.flutter.inspector.show', { enabled: false })
