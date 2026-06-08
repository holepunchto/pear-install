'use strict'
const test = require('brittle')
const path = require('path')
const fs = require('fs')
const createTestnet = require('hyperdht/testnet')
const hypercoreCrypto = require('hypercore-crypto')
const hid = require('hypercore-id-encoding')
const plink = require('pear-link')
const { isWindows } = require('which-runtime')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const Hyperswarm = require('hyperswarm')
const Install = require('..')
const { seed, run, arch, bootstrapArg } = require('./helper')

test('successful bin install via testnet', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
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
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: {}
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
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
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'NEW' }
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
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
    const key = await seed(t, {
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
    })
    const link = plink.serialize({ drive: { key } })
    const target = await tmp(t)
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
    const key = await seed(t, {
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: {}
    })
    const link = plink.serialize({ drive: { key } })
    const target = await tmp(t)
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
    const key = await seed(t, {
      bootstrap: testnet.bootstrap,
      manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
      files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
    })
    const link = plink.serialize({ drive: { key } })
    const target = await tmp(t)
    fs.writeFileSync(path.join(target, 'tbin'), 'EXISTING')
    const { stdout } = await run(['--to', target, '--dht-bootstrap', bootstrapArg(testnet), link])
    t.ok(stdout.includes('Refusing to overwrite existing'), 'refusing message printed')
    t.ok(stdout.includes('manually remove then rerun'), 'fix hint printed')
  }
)

test('_move falls back to copy+rm on EXDEV', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
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

test('accepts injected corestore and swarm', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
  })
  const storage = await tmp(t)
  const corestore = new Corestore(storage)
  await corestore.ready()
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (c) => corestore.replicate(c))
  t.teardown(async () => {
    await swarm.destroy()
    await corestore.close()
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
  const install = new Install({
    link,
    to: target,
    bootstrap: testnet.bootstrap,
    corestore,
    swarm
  })
  await install.ready()
  t.is(fs.readFileSync(path.join(target, 'tbin'), 'utf8'), 'BIN', 'bin written to target')
  await install.close()
  t.is(corestore.closed, false, 'injected corestore not closed by install')
  t.is(swarm.destroyed, false, 'injected swarm not destroyed by install')
})

test('injected corestore reused for second install', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const keyA = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin-a', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin-a']: 'A' }
  })
  const keyB = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin-b', version: '1.0.0', upgrade: 'pear://y', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin-b']: 'B' }
  })
  const storage = await tmp(t)
  const corestore = new Corestore(storage)
  await corestore.ready()
  const swarm = new Hyperswarm({ bootstrap: testnet.bootstrap })
  swarm.on('connection', (c) => corestore.replicate(c))
  t.teardown(async () => {
    await swarm.destroy()
    await corestore.close()
  })
  const targetA = await tmp(t)
  const targetB = await tmp(t)

  const first = new Install({
    link: plink.serialize({ drive: { key: keyA } }),
    to: targetA,
    bootstrap: testnet.bootstrap,
    corestore,
    swarm
  })
  await first.ready()
  await first.close()
  t.is(fs.readFileSync(path.join(targetA, 'tbin-a'), 'utf8'), 'A', 'first install wrote bin')

  const second = new Install({
    link: plink.serialize({ drive: { key: keyB } }),
    to: targetB,
    bootstrap: testnet.bootstrap,
    corestore,
    swarm
  })
  await second.ready()
  await second.close()
  t.is(fs.readFileSync(path.join(targetB, 'tbin-b'), 'utf8'), 'B', 'second install wrote bin')
})

test('permission denied when target dir is read-only', { skip: isWindows }, async function (t) {
  t.timeout(60000)
  const testnet = await createTestnet(3, t.teardown)
  const key = await seed(t, {
    bootstrap: testnet.bootstrap,
    manifest: { name: 'tbin', version: '1.0.0', upgrade: 'pear://x', bin: 'cli.js' },
    files: { ['/by-arch/' + arch + '/app/tbin']: 'BIN' }
  })
  const link = plink.serialize({ drive: { key } })
  const target = await tmp(t)
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
})
