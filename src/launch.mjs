// `.vscode/launch.json` and `.vscode/tasks.json`: the per-environment run setup Dart-Code uses.
// Orca has no launch contribution point, so the plugin reads the same files and appends the chosen
// configuration's `args` to `flutter run`, running its `preLaunchTask` first. Pure, so it is unit tested.

// VS Code reads these files as JSONC: line and block comments, and trailing commas.
export function stripJsonc(text) {
  const out = []
  let inString = false
  let inLine = false
  let inBlock = false
  let commaAt = -1
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    const next = text[i + 1]
    if (inLine) {
      if (c === '\n') {
        inLine = false
        out.push(c)
      }
      continue
    }
    if (inBlock) {
      if (c === '*' && next === '/') {
        inBlock = false
        i++
      }
      continue
    }
    if (inString) {
      out.push(c)
      if (c === '\\') {
        out.push(next)
        i++
      } else if (c === '"') inString = false
      continue
    }
    if (c === '"') {
      if (commaAt >= 0) out.splice(commaAt, 0, ',')
      commaAt = -1
      inString = true
      out.push(c)
    } else if (c === '/' && next === '/') {
      inLine = true
      i++
    } else if (c === '/' && next === '*') {
      inBlock = true
      i++
    } else if (c === ',') {
      let at = out.length
      while (at > 0 && (out[at - 1] === ' ' || out[at - 1] === '\t' || out[at - 1] === '\n' || out[at - 1] === '\r')) at--
      commaAt = at
    } else if (c === '}' || c === ']') {
      commaAt = -1
      out.push(c)
    } else if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      out.push(c)
    } else {
      if (commaAt >= 0) out.splice(commaAt, 0, ',')
      commaAt = -1
      out.push(c)
    }
  }
  return out.join('')
}

export function parseJsonc(text) {
  return JSON.parse(stripJsonc(text))
}

// The Dart and Flutter entries of launch.json, with the shell command of their preLaunchTask (a label in tasks.json).
export function launchConfigurations(launchText, tasksText) {
  const launch = launchText ? parseJsonc(launchText) : {}
  const tasks = tasksText ? parseJsonc(tasksText) : {}
  const commands = new Map()
  for (const task of Array.isArray(tasks.tasks) ? tasks.tasks : []) {
    if (typeof task?.label === 'string' && typeof task?.command === 'string') commands.set(task.label, task.command)
  }
  const list = []
  for (const entry of Array.isArray(launch.configurations) ? launch.configurations : []) {
    const name = entry?.name
    const type = entry?.type
    if (typeof name !== 'string' || typeof type !== 'string' || !/^(dart|flutter)$/i.test(type)) continue
    const args = Array.isArray(entry.args) ? entry.args.filter((a) => typeof a === 'string') : []
    const preLaunchTask = typeof entry.preLaunchTask === 'string' ? entry.preLaunchTask : null
    list.push({ name, args, preLaunchTask, preCommand: preLaunchTask ? (commands.get(preLaunchTask) ?? null) : null })
  }
  return list
}

const plain = /^[A-Za-z0-9_@%+=:,./-]+$/
const shellQuote = (value) => (plain.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`)

// `[preLaunchTask &&] flutter run <args> -d <device>`. Values come from the repository's own launch.json.
export function runCommandText(base, args = [], preCommand = null, deviceId = null) {
  const parts = [base, ...args.map(shellQuote)]
  if (deviceId) parts.push('-d', shellQuote(deviceId))
  const command = parts.join(' ')
  return preCommand ? `${preCommand} && ${command}` : command
}
