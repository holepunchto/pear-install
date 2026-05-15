'use strict'
const test = require('brittle')
const path = require('path')
const fs = require('fs')
const createTestnet = require('hyperdht/testnet')
const hypercoreCrypto = require('hypercore-crypto')
const hid = require('hypercore-id-encoding')
const plink = require('pear-link')
const { isWindows } = require('which-runtime')
const { tmpdir, seed, run, arch, bootstrapArg } = require('./helper')

test('successful bin install via testnet', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed({
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' },
    teardown: t.teardown
  })
  const link = plink.serialize({ drive: { key } })
  const target = tmpdir('install-target-', t.teardown)
  const { events } = await run([
    '--json',
    '--to',
    target,
    '--dht-bootstrap',
    bootstrapArg(testnet),
    link
  ])
  const final = events.find((e) => e.tag === 'final')
  t.ok(final, 'final event emitted')
  t.is(final.data.success, true, 'success')
  t.is(fs.readFileSync(path.join(target, 'tbin'), 'utf8'), 'BIN', 'bin written to target')
})

test('notFound emits full pear:// link when platform binary missing', async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed({
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: {},
    teardown: t.teardown
  })
  const link = plink.serialize({ drive: { key } })
  const target = tmpdir('install-target-', t.teardown)
  const { events } = await run([
    '--json',
    '--to',
    target,
    '--dht-bootstrap',
    bootstrapArg(testnet),
    link
  ])
  const final = events.find((e) => e.tag === 'final')
  const error = events.find((e) => e.tag === 'error')
  t.ok(final, 'final event emitted')
  t.is(final.data.success, false, 'failure')
  t.is(error?.data.code, 'ERR_NOT_FOUND', 'ERR_NOT_FOUND emitted')
  t.ok(error?.data.message.includes('pear://'), 'error message includes pear link')
  t.ok(
    error?.data.message.includes('/by-arch/' + arch + '/app/tbin'),
    'error message includes platform path'
  )
})

test('refuses to overwrite an existing install', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed({
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'NEW' },
    teardown: t.teardown
  })
  const link = plink.serialize({ drive: { key } })
  const target = tmpdir('install-target-', t.teardown)
  fs.writeFileSync(path.join(target, 'tbin'), 'EXISTING')
  const { events } = await run([
    '--json',
    '--to',
    target,
    '--dht-bootstrap',
    bootstrapArg(testnet),
    link
  ])
  const final = events.find((e) => e.tag === 'final')
  const error = events.find((e) => e.tag === 'error')
  t.ok(final, 'final event emitted')
  t.is(final.data.success, false, 'failure')
  t.is(error?.data.code, 'ERR_EXISTS', 'ERR_EXISTS emitted')
  t.ok(
    error?.data.message.includes('Refusing to overwrite existing'),
    'error message reports refusal'
  )
  t.ok(
    error?.data.message.includes(path.join(target, 'tbin')),
    'error message lists existing target path'
  )
  t.is(fs.readFileSync(path.join(target, 'tbin'), 'utf8'), 'EXISTING', 'existing file untouched')
})

test('invalid port in --dht-bootstrap reaches bail handler', async function (t) {
  const { bail: info } = await run([
    '--dht-bootstrap',
    '127.0.0.1:nope',
    'pear://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
  ])
  t.ok(info, 'bail handler invoked')
  t.is(info.err?.message, 'Invalid port: nope')
})

test('link with pathname emits error event', async function (t) {
  const key = hid.encode(hypercoreCrypto.keyPair().publicKey)
  const link = `pear://${key}/some/path`
  const { events } = await run(['--json', link])
  const error = events.find((e) => e.tag === 'error')
  t.ok(error, 'error event emitted')
  t.is(error.data.message, 'Link must not have pathname')
})

test(
  'non-json output prints installing, app and Installed',
  { skip: isWindows },
  async function (t) {
    t.timeout(60000)
    const testnet = await createTestnet(3, t.teardown)
    const key = await seed({
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' },
      teardown: t.teardown
    })
    const link = plink.serialize({ drive: { key } })
    const target = tmpdir('install-target-', t.teardown)
    const { stdout } = await run(['--to', target, '--dht-bootstrap', bootstrapArg(testnet), link])
    t.ok(stdout.includes('Installing...'), 'installing message printed')
    t.ok(stdout.includes('App: tbin'), 'app message printed')
    t.ok(stdout.includes('Installed'), 'final installed message printed')
  }
)

test(
  'non-json output prints Not found for missing platform binary',
  { skip: isWindows },
  async function (t) {
    t.timeout(60000)
    const testnet = await createTestnet(3, t.teardown)
    const key = await seed({
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: {},
      teardown: t.teardown
    })
    const link = plink.serialize({ drive: { key } })
    const target = tmpdir('install-target-', t.teardown)
    const { stdout } = await run(['--to', target, '--dht-bootstrap', bootstrapArg(testnet), link])
    t.ok(stdout.includes('Not found: pear://'), 'not found message printed')
  }
)

test(
  'non-json output prints Refusing to overwrite for existing target',
  { skip: isWindows },
  async function (t) {
    t.timeout(60000)
    const testnet = await createTestnet(3, t.teardown)
    const key = await seed({
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' },
      teardown: t.teardown
    })
    const link = plink.serialize({ drive: { key } })
    const target = tmpdir('install-target-', t.teardown)
    fs.writeFileSync(path.join(target, 'tbin'), 'EXISTING')
    const { stdout } = await run(['--to', target, '--dht-bootstrap', bootstrapArg(testnet), link])
    t.ok(stdout.includes('Refusing to overwrite existing'), 'refusing message printed')
    t.ok(stdout.includes('Manually remove first'), 'fix hint printed')
  }
)

test('_move falls back to copy+rm on EXDEV', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed({
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' },
    teardown: t.teardown
  })
  const link = plink.serialize({ drive: { key } })
  const target = tmpdir('install-target-', t.teardown)
  const renameSync = fs.renameSync
  fs.renameSync = function () {
    const err = new Error('cross-device link not permitted')
    err.code = 'EXDEV'
    throw err
  }
  t.teardown(() => {
    fs.renameSync = renameSync
  })
  const { events } = await run([
    '--json',
    '--to',
    target,
    '--dht-bootstrap',
    bootstrapArg(testnet),
    link
  ])
  const final = events.find((e) => e.tag === 'final')
  t.is(final?.data?.success, true, 'install succeeded via copy+rm fallback')
  t.is(fs.readFileSync(path.join(target, 'tbin'), 'utf8'), 'BIN', 'bin content copied to target')
})

test('permission denied when target dir is read-only', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed({
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' },
    teardown: t.teardown
  })
  const link = plink.serialize({ drive: { key } })
  const target = tmpdir('install-target-', t.teardown)
  fs.chmodSync(target, 0o555)
  t.teardown(() => {
    try {
      fs.chmodSync(target, 0o755)
    } catch {}
  })
  const { events, stdout } = await run([
    '--to',
    target,
    '--dht-bootstrap',
    bootstrapArg(testnet),
    link
  ])
  // since no --json, events is empty; assert via stdout
  t.is(events.length, 0, 'no json events (non-json mode)')
  t.ok(stdout.includes('Permission denied'), 'permission message printed')
  t.ok(stdout.includes('Fix:'), 'fix hint printed')
})
