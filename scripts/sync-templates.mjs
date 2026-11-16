// Builds templates/*.dart (used by contributes.newFiles) from the Dart-Code Flutter snippets.
// `$1` becomes MyWidget and `${0:text}` becomes text. The snippets have no imports, so one is added.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const SOURCE = 'submodules/Dart-Code/snippets/flutter.json'
const FILES = { stless: 'stateless_widget', stful: 'stateful_widget', stanim: 'animated_widget' }

const snippets = JSON.parse(readFileSync(SOURCE, 'utf8'))['.source.dart']
mkdirSync('templates', { recursive: true })

for (const { prefix, body } of Object.values(snippets)) {
  const name = FILES[prefix]
  if (!name) continue
  const code = (Array.isArray(body) ? body.join('\n') : body)
    .replace(/\$\{\d+:([^}]*)\}/g, '$1')
    .replace(/\$\d+/g, 'MyWidget')
  writeFileSync(`templates/${name}.dart`, `import 'package:flutter/material.dart';\n\n${code}\n`)
  console.log(`templates/${name}.dart`)
}
