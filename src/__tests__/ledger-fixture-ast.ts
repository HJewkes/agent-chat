// AST helpers operate on owned fixture copies only; no source printer or code evaluation.
import { strict as assert } from 'node:assert'
import { createHash } from 'node:crypto'
import ts from 'typescript'

const sha = (text: string) => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')
const actionNames = ['doctorLifecycle', 'backfill'] as const
type ActionName = (typeof actionNames)[number]

export function decodeExactUtf8(bytes: Buffer) {
  const text = bytes.toString('utf8')
  assert(Buffer.from(text, 'utf8').equals(bytes), 'original module bytes must roundtrip exactly')
  return text
}

function parsed(source: string) {
  const file = ts.createSourceFile('owned-fixture.js', source, ts.ScriptTarget.ESNext, true, ts.ScriptKind.JS)
  // parseDiagnostics is an internal compiler field; the final fixture will use a narrow
  // structural type for diagnostics only, never cast production action/command types.
  const diagnostics = (file as ts.SourceFile & { parseDiagnostics: readonly ts.Diagnostic[] })
    .parseDiagnostics
  assert.equal(diagnostics.length, 0, 'owned emitted module must parse without recovery')
  return file
}

function action(file: ts.SourceFile, name: ActionName) {
  const matches = file.statements.filter(
    (node): node is ts.FunctionDeclaration => ts.isFunctionDeclaration(node) && node.name?.text === name,
  )
  assert.equal(matches.length, 1, 'exactly one top-level named original action')
  const node = matches[0]!
  assert(node.body, 'original action has a body')
  assert.equal(node.parameters.length, 1, 'capture only the original declared options argument')
  assert(node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword))
  return node as ts.FunctionDeclaration & { body: ts.Block }
}

export function isolateOnlyOwnedActionBody(source: string, name: ActionName) {
  const file = parsed(source)
  const node = action(file, name)
  assert.equal(node.parameters[0]!.name.getText(file), name === 'doctorLifecycle' ? 'options' : 'opts')
  const originalBody = node.body.getText(file)
  const visit = (child: ts.Node): void => {
    assert.notEqual(child.kind, ts.SyntaxKind.ThisKeyword, 'original does not use Commander this')
    assert(!(ts.isIdentifier(child) && child.text === 'arguments'), 'original does not use extra arguments')
    ts.forEachChild(child, visit)
  }
  visit(node.body)
  const start = node.body.getStart(file)
  const end = node.body.end
  const prefix = source.slice(0, start)
  const suffix = source.slice(end)
  const parameter = node.parameters[0]!.name.getText(file)
  const replacement = `{ return globalThis.__ledgerFixture.effect(${JSON.stringify(name)}, ${parameter}); }`
  const changed = prefix + replacement + suffix
  assert.equal(changed.slice(0, start), prefix)
  assert.equal(changed.slice(start + replacement.length), suffix)
  const changedFile = parsed(changed)
  assert.equal(action(changedFile, name).body.getText(changedFile), replacement)
  return {
    source: changed,
    proof: {
      originalSourceSha256: sha(source),
      originalActionBodySha256: sha(originalBody + '\n'),
      untouchedPrefixSha256: sha(prefix),
      untouchedSuffixSha256: sha(suffix),
      originalBodyStart: start,
      originalBodyEnd: end,
      fakeBodySha256: sha(replacement),
      fakeSourceSha256: sha(changed),
      replacementCount: 1,
      outsideBodyByteExact: true,
      originalMetadataNotReimplemented: true,
    },
  }
}

export function exposeOnlyOwnedOriginalAction(source: string, name: ActionName) {
  const file = parsed(source)
  const node = action(file, name)
  const originalBody = node.body.getText(file)
  const alreadyExported = node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  const suffix = alreadyExported ? '' : `\nexport { ${name} };\n`
  const changed = source + suffix
  assert.equal(changed.slice(0, source.length), source, 'entire original producer bytes retained')
  const changedFile = parsed(changed)
  assert.equal(action(changedFile, name).body.getText(changedFile), originalBody)
  return {
    source: changed,
    proof: {
      originalSourceSha256: sha(source),
      originalActionBodySha256: sha(originalBody + '\n'),
      completeOriginalBytesPreserved: true,
      testOnlyExportAppended: !alreadyExported,
      originalPrivateProducerNotReimplemented: true,
    },
  }
}

export function emittedRuntimeExportNames(source: string) {
  const file = parsed(source)
  const names = new Set<string>()
  for (const node of file.statements) {
    if (ts.isExportDeclaration(node)) {
      assert(node.exportClause && ts.isNamedExports(node.exportClause), 'unknown/star exports fail closed')
      for (const item of node.exportClause.elements) names.add(item.name.text)
      continue
    }
    if (
      !ts.canHaveModifiers(node) ||
      !ts.getModifiers(node)?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)
    )
      continue
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name)
      names.add(node.name.text)
    else if (ts.isVariableStatement(node)) {
      for (const item of node.declarationList.declarations) {
        assert(ts.isIdentifier(item.name), 'unknown exported destructuring fails closed')
        names.add(item.name.text)
      }
    } else assert.fail('unsupported runtime export shape')
  }
  return [...names].sort()
}

export function exactDependencyModule(original: string, implementations: Readonly<Record<string, string>>) {
  const names = emittedRuntimeExportNames(original)
  for (const name of Object.keys(implementations))
    assert(names.includes(name), 'fake must match actual named export')
  const declarations = names.map(name => implementations[name] ?? `export const ${name}=forbidden;`)
  const generated = [
    'const f=globalThis.__ledgerFixture;',
    'const forbidden=()=>{throw Error("unexpected original ledger dependency");};',
    ...declarations,
  ].join('\n')
  parsed(generated)
  return generated
}
