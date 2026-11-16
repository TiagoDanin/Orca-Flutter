#!/usr/bin/env bash
# Updates the submodules to upstream and copies the files the plugin uses out of submodules/.
# Usage: scripts/sync.sh [--no-update]   (--no-update copies from the already pinned commit, without fetching upstream)
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${1:-}" != "--no-update" ]; then
  git submodule update --init --remote --depth 1
else
  git submodule update --init --depth 1
fi

D=submodules/Dart-Code/syntaxes
cp "$D/dart.json" syntaxes/dart.tmLanguage.json
cp "$D/dart.json.license" syntaxes/dart-LICENSE.txt
# syntaxes/language-configuration.json is ours: the Dart-Code one uses array surroundingPairs, which Orca rejects.
node scripts/sync-templates.mjs

orca plugin validate .
git submodule status
git status --short syntaxes templates
