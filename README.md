# Orca Flutter

Flutter and Dart support for [Orca](https://orca.dev), modeled on the `Dart-Code.flutter` and `Dart-Code.dart-code` VS Code extensions. Orca plugins cannot load VS Code extensions, so this is a separate plugin that covers what Orca's plugin API allows.

Status: early. The pure logic is tested against the real `flutter` and `dart` CLIs, but the plugin has not been fully exercised inside a running Orca yet.

## What it does

| Area | Features |
| --- | --- |
| Run | `flutter run`, profile, release and attach on the selected device. One run per plugin; Run focuses the existing terminal. |
| Hot reload | Reload, restart and stop from the palette, shortcuts or panel. Optional reload on save. |
| Debug tools | Widget inspector, debug paint, performance overlay, platform, brightness, screenshot, widget and render tree dumps, DevTools. |
| Devices | Device list from `flutter devices --machine`, emulator list and launch. Pressing the device in the status bar switches to the next one. |
| Status bar | Selected device and run state (idle, starting, running, reloading, restarting). |
| Problems | `dart analyze` results in a list. Clicking a problem opens the file. Dart Fix and Dart Format buttons. |
| Project | Pub get, upgrade, outdated and add, build_runner, gen-l10n, clean, tests and coverage, Flutter doctor, upgrade and create. |
| Files | Dart syntax highlighting, and New Dart file, StatelessWidget, StatefulWidget and AnimationController widget in the tab bar + menu. |

## FVM

Every command runs through `fvm flutter` and `fvm dart` when the project pins a version with `.fvmrc` (or the legacy `.fvm/fvm_config.json`) in the project or a parent folder. Otherwise it uses `flutter` and `dart` from PATH. The `sdkMode` setting forces one or the other.

## Install

The plugin runs code in a worker, so Orca asks for approval. From the plugin folder:

```
orca plugin dev load .
orca plugin dev load . --approve <fingerprint>
```

Orca prints the fingerprint on the first call. After a change that adds access, reload with `orca plugin dev reload . --approve <fingerprint>`.

## Use

Select a workspace, then use any of these:

- The Flutter panel in the right sidebar, with a button for every action.
- The command palette (`Ctrl+Shift+J`): type `Flutter`.
- Shortcuts: Run `Ctrl+Shift+X`, Hot Reload `Ctrl+Shift+L`, Hot Restart `Ctrl+Shift+K`, Doctor `Ctrl+Shift+S`, Run Tests `Ctrl+Shift+U`, Create Project `Ctrl+Shift+P`. They are Cmd on macOS.

Settings, under the plugin in Orca's Settings:

| Setting | Default | Effect |
| --- | --- | --- |
| `hotReloadOnSave` | on | Sends `r` to the running app after an explicit save of a Dart file. Autosave does not trigger it. |
| `formatOnSave` | off | Runs `dart format` on a Dart file before an explicit save. |
| `sdkMode` | auto | `auto` follows the FVM pin, `fvm` always uses FVM, `flutter` never does. |

## Limits

Orca has no contribution point for these, so they are not part of the plugin:

- Breakpoints and stepping in the editor. DevTools opens in the system browser and has a debugger page.
- Completion, hover and quick fixes (no language server support).
- Inline snippets. Templates for new files replace them.
- Commands on the active editor file, Flutter Outline and the widget inspector inside the editor.

Also not implemented: an explicit SDK path (PowerShell and cmd quote differently), creating emulators, opening in Android Studio or Xcode.

Device and emulator listing and FVM detection work on local workspaces only. SSH workspaces use plain `flutter`.

## Development

```
node --test src/*.test.mjs
orca plugin validate .
```

The tests check the parsers against real CLI output, `dart format` through the real `dart`, and that the manifest, the worker and the panel agree on command and request names.

`submodules/Dart-Code` and `submodules/Flutter` are the upstream extensions, kept as reference. The plugin never reads from them directly. `scripts/sync.sh` updates them, copies the Dart grammar and license into `syntaxes/`, regenerates `templates/` from the Dart-Code snippets and validates the manifest.

Orca's Git tree reader rejects submodules in an installed plugin. Publish from a branch or tag that does not contain `submodules/`.

## Credits and license

MIT, see `LICENSE`. The Dart grammar in `syntaxes/dart.tmLanguage.json` comes from `dart-lang/dart-syntax-highlight` (BSD-3, see `syntaxes/dart-LICENSE.txt`). The file templates are built from the Dart-Code snippets. The icon is the Flutter logo, a Google trademark.
