import { spawn } from 'node:child_process'

// Formats Dart source with `dart format`, which reads stdin and writes stdout.
// Returns null when it fails or is too slow (for example a syntax error), so the save is left alone.
// shortcut: a file with CRLF line endings comes back with LF; revisit if that bites.
export function formatDart(dart, text, cwd, timeoutMs = 1500) {
  return new Promise((done) => {
    // The command is built only from constants (`dart` or `fvm dart`), so the shell is safe here.
    const child = spawn(`${dart} format`, { shell: true, cwd, windowsHide: true })
    let out = ''
    const finish = (value) => {
      clearTimeout(timer)
      done(value)
    }
    const timer = setTimeout(() => {
      child.kill()
      finish(null)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => (out += chunk))
    child.on('error', () => finish(null))
    child.on('close', (code) => finish(code === 0 ? out : null))
    child.stdin.on('error', () => {})
    child.stdin.end(text)
  })
}
