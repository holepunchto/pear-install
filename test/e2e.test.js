'use strict'
const test = require('brittle')
const path = require('path')
const fs = require('fs')
const tmp = require('test-tmp')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const crypto = require('hypercore-crypto')
const plink = require('pear-link')
const { isWindows } = require('which-runtime')
const InstallCmd = require('../cmd')
const { arch } = require('./helper')

const PEAR_KEY = 'pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy'
const pearExe = isWindows ? 'pear.exe' : 'pear'

test(
  'e2e installs pear from production key',
  // windows: installer would mutate the runner's User PATH via powershell
  { skip: isWindows },
  async function (t) {
    t.timeout(300_000)

    const dir = await tmp(t)
    const installDir = path.join(dir, 'install')
    const installedPear = path.join(installDir, pearExe)
    await fs.promises.mkdir(installDir, { recursive: true })

    const store = new Corestore(path.join(dir, 'store'))
    t.teardown(async () => {
      await store.close()
    })

    t.comment('install pear')
    let finalInstall = null
    for await (const event of new InstallCmd({
      link: PEAR_KEY,
      to: installDir,
      timeout: 120_000,
      corestore: store
    })) {
      if (event.tag === 'error') t.comment(event.data.message)
      if (event.tag === 'final') finalInstall = event.data
    }
    t.ok(finalInstall?.success, 'installed successfully')

    t.ok(fs.existsSync(installedPear), `installed ${installedPear}`)
    const stat = await fs.promises.stat(installedPear)
    t.ok(stat.mode & 0o111, 'installed binary is executable')

    const drive = new Hyperdrive(store, plink.parse(PEAR_KEY).drive.key)
    t.teardown(async () => {
      await drive.close()
    })
    await drive.ready()
    const expected = await drive.get('/by-arch/' + arch + '/app/' + pearExe, { timeout: 30_000 })
    t.ok(expected, 'drive holds the platform binary')
    if (expected) {
      t.alike(
        crypto.data(await fs.promises.readFile(installedPear)),
        crypto.data(expected),
        'installed binary checksum matches drive'
      )
    }
  }
)
