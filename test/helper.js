'use strict'
const path = require('path')
const fs = require('fs')
const os = require('os')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const { command, arg, bail } = require('paparam')
const pkg = require('../package.json')
const install = require('..')
const process = require('process')
const arch = `${process.platform}-${process.arch}`

function rmDir(dir) {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100
  })
}

function tmpdir(prefix, teardown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  teardown(() => rmDir(dir))
  return dir
}

async function seed({ bootstrap, manifest, files, teardown }) {
  const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'pear-install-seed-'))
  const corestore = new Corestore(storage)
  const drive = new Hyperdrive(corestore)
  await drive.ready()
  await drive.put('/package.json', Buffer.from(JSON.stringify(manifest)))
  for (const [p, content] of Object.entries(files)) {
    await drive.put(p, Buffer.from(content))
  }
  const swarm = new Hyperswarm({ bootstrap })
  swarm.on('connection', (c) => corestore.replicate(c))
  swarm.join(drive.discoveryKey, { server: true, client: false })
  await swarm.flush()
  teardown(async () => {
    await swarm.destroy()
    await drive.close()
    await corestore.close()
    rmDir(storage)
  })
  return drive.key
}

async function run(args) {
  const lines = []
  let buf = ''
  const origWrite = process.stdout.write
  const origExitCode = process.exitCode
  process.stdout.write = function (chunk) {
    buf += chunk.toString()
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      lines.push(buf.slice(0, i))
      buf = buf.slice(i + 1)
    }
    return true
  }
  let bailInfo = null
  let exitCode
  try {
    const program = command(
      'install',
      arg('[link]', 'Pear link'),
      pkg.command,
      install,
      bail((info) => {
        bailInfo = info
      })
    )
    const c = program.parse(args, { run: true })
    if (c?.running) await c.running.catch(() => {})
  } finally {
    process.stdout.write = origWrite
    exitCode = process.exitCode
    process.exitCode = origExitCode
  }
  const events = lines.flatMap((l) => {
    try {
      return [JSON.parse(l)]
    } catch {
      return []
    }
  })
  return { events, bail: bailInfo, stdout: lines.join('\n') + buf, exitCode }
}

function bootstrapArg(testnet) {
  return testnet.bootstrap.map((b) => `${b.host}:${b.port}`).join(',')
}

module.exports = { tmpdir, seed, run, arch, bootstrapArg }
