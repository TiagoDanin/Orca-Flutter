import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// FVM looks for .fvmrc (current) or .fvm/fvm_config.json (legacy) in the project and its parents.
export function findFvmRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.fvmrc')) || existsSync(join(d, '.fvm', 'fvm_config.json'))) return d
    if (dirname(d) === d) return null
  }
}

// `fvm flutter` runs the SDK pinned by the project; without a pin, plain `flutter` from PATH.
export function flutterCommand(dir) {
  return dir && findFvmRoot(dir) ? 'fvm flutter' : 'flutter'
}
