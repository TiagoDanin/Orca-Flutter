import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

// FVM looks for .fvmrc (current) or .fvm/fvm_config.json (legacy) in the project and its parents.
export function findFvmRoot(dir) {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, '.fvmrc')) || existsSync(join(d, '.fvm', 'fvm_config.json'))) return d
    if (dirname(d) === d) return null
  }
}

export const SDK_MODES = ['auto', 'fvm', 'flutter']

// mode: `auto` uses FVM only when the project pins it, `fvm` always, `flutter` never (the sdkMode setting).
const useFvm = (dir, mode) => mode === 'fvm' || (mode !== 'flutter' && Boolean(dir && findFvmRoot(dir)))

// `fvm flutter` runs the SDK pinned by the project; otherwise plain `flutter` from PATH.
export function flutterCommand(dir, mode = 'auto') {
  return useFvm(dir, mode) ? 'fvm flutter' : 'flutter'
}

// Same rule for `dart`, so build_runner, analyze and format run on the pinned SDK too.
export function dartCommand(dir, mode = 'auto') {
  return useFvm(dir, mode) ? 'fvm dart' : 'dart'
}
