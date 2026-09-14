import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

function runNpm(args, options = {}) {
  if (process.platform !== 'win32') return run('npm', args, options)
  const command = ['npm.cmd', ...args.map(String)].join(' ')
  return run(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', command], options)
}

test('packed SDK verifies a portable bundle in a clean zero-network consumer', async (t) => {
  const coreTarball = process.env.OCD_AGENT_EVIDENCE_TARBALL
  assert.ok(coreTarball, 'OCD_AGENT_EVIDENCE_TARBALL is required for the pre-release packed-install test')

  const dir = mkdtempSync(join(tmpdir(), 'ocd-sdk-installed-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const artifacts = join(dir, 'artifacts')
  const consumer = join(dir, 'consumer')
  mkdirSync(artifacts)
  mkdirSync(consumer)

  const packed = await runNpm(['pack', '--json', '--pack-destination', artifacts], { cwd: root, env: process.env })
  assert.equal(packed.code, 0, `${packed.stderr}\n${packed.stdout}`)
  const sdkTarball = join(artifacts, JSON.parse(packed.stdout)[0].filename)
  const install = await runNpm(
    ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', coreTarball, sdkTarball],
    { cwd: consumer, env: process.env },
  )
  assert.equal(install.code, 0, install.stderr)

  const corpus = join(root, 'node_modules', '@onchaindiligence', 'agent-evidence', 'conformance')
  const bundle = JSON.parse(readFileSync(join(corpus, 'bundle-with-artifacts.json'), 'utf8'))
  const invalidReceiptBundle = JSON.parse(readFileSync(
    join(corpus, 'bundle-invalid-embedded-receipt-no-external-proof.json'),
    'utf8',
  ))
  writeFileSync(join(consumer, 'bundle.json'), JSON.stringify(bundle))
  writeFileSync(join(consumer, 'invalid-receipt-bundle.json'), JSON.stringify(invalidReceiptBundle))
  writeFileSync(join(consumer, 'keys.json'), JSON.stringify(bundle.verification_material.keys))
  writeFileSync(join(consumer, 'verify.mjs'), [
    "globalThis.fetch = () => { throw new Error('network access attempted') }",
    "import { readFileSync } from 'node:fs'",
    "import { verifyBundleOffline } from '@onchaindiligence/sdk'",
    "const bundle = JSON.parse(readFileSync('bundle.json', 'utf8'))",
    "const invalidReceiptBundle = JSON.parse(readFileSync('invalid-receipt-bundle.json', 'utf8'))",
    "const keys = JSON.parse(readFileSync('keys.json', 'utf8'))",
    "const options = { now: new Date('2026-08-28T12:01:00.000Z') }",
    'const report = verifyBundleOffline(bundle, keys, options)',
    'const invalidReceiptReport = verifyBundleOffline(invalidReceiptBundle, keys, options)',
    'process.stdout.write(JSON.stringify({ report, invalidReceiptReport }))',
  ].join('\n'))

  const verified = await run(process.execPath, [join(consumer, 'verify.mjs')], { cwd: consumer })
  assert.equal(verified.code, 0, verified.stderr)
  const { report, invalidReceiptReport } = JSON.parse(verified.stdout)
  assert.equal(report.bundle_integrity.state, 'VALID')
  assert.ok(Array.isArray(report.artifact_verifications))
  assert.ok(report.reconciliation)
  assert.ok(Array.isArray(report.limitations))
  assert.equal(invalidReceiptReport.bundle_integrity.state, 'VALID')
  assert.equal(invalidReceiptReport.state, 'INVALID')
  assert.ok(invalidReceiptReport.components.some(
    (component) => component.component === 'receipt-proof' && component.state === 'INVALID',
  ))
})
