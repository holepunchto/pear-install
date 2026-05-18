'use strict'
const path = require('path')
const os = require('os')
const fs = require('fs')
const { spawnSync } = require('child_process')
const process = require('process')
const LocalDrive = require('localdrive')
const { isMac, isLinux, isWindows } = require('which-runtime')
const crypto = require('hypercore-crypto')
const Corestore = require('corestore')
const Hyperdrive = require('hyperdrive')
const Hyperswarm = require('hyperswarm')
const plink = require('pear-link')
const PearError = require('pear-errors')
const ReadyResource = require('ready-resource')
const { ERR_INVALID_MANIFEST, ERR_NOT_FOUND, ERR_PERMISSION_REQUIRED, ERR_UNKNOWN } = PearError

function ERR_NETWORK_TIMEOUT(msg, info = null) {
  return new PearError(msg, ERR_NETWORK_TIMEOUT, info)
}

function ERR_EXISTS(msg, info = null) {
  return new PearError(msg, ERR_EXISTS, info)
}

const PEAR_DIR = isMac
  ? path.join(os.homedir(), 'Library', 'Application Support', 'pear')
  : isLinux
    ? path.join(os.homedir(), '.config', 'pear')
    : path.join(os.homedir(), 'AppData', 'Roaming', 'pear')

class Install extends ReadyResource {
  constructor({ link, only, to, bootstrap, timeout = 30_000, corestore = null, swarm = null }) {
    super()
    this.doneFinding = null
    this.link = link
    this.only = only
    this.to = to
    this.bootstrap = bootstrap
    this.timeout = timeout
    this.targets = []
    this.base = null
    this.drive = null
    this.corestore = corestore
    this.swarm = swarm
    this._ownCorestore = corestore === null
    this._ownSwarm = swarm === null
  }
  async _open() {
    try {
      await this._install()
    } catch (err) {
      await this._teardown()
      throw err
    }
  }
  async _install() {
    const { link, only, to, bootstrap, timeout = 30_000 } = this
    const parsed = plink.parse(link)
    if (parsed.pathname) throw new Error('Link must not have pathname')
    const host = process.platform + '-' + process.arch
    this.emit('installing', { link, host })

    const rand = crypto.randomBytes(16).toString('hex')
    this.base = path.join(PEAR_DIR, 'gc', rand)
    fs.mkdirSync(this.base, { recursive: true })

    if (this._ownCorestore) this.corestore = new Corestore(this.base)
    if (this._ownSwarm) this.swarm = new Hyperswarm({ bootstrap })

    this.drive = new Hyperdrive(this.corestore.session(), parsed.drive.key)

    await this.drive.ready()
    this.doneFinding = this.drive.findingPeers()
    const topic = this.swarm.join(this.drive.discoveryKey, { server: false, client: true })
    this.swarm.on('connection', (c) => this.corestore.replicate(c))

    let serving = false
    this.swarm.dht.on('nat-update', () => {
      if (!this.swarm.dht.randomized && !serving) {
        serving = true
        this.swarm
          .join(this.drive.discoveryKey, { server: true, client: false })
          .flushed()
          .then(() => topic.destroy())
      }
    })
    const deferred = Promise.withResolvers()
    const countdown = setTimeout(() => {
      deferred.reject(ERR_NETWORK_TIMEOUT('Network Timeout ' + timeout / 1000 + 's'))
    }, timeout)
    await Promise.race([this.drive.core.update({ wait: true }), deferred.promise])
    clearTimeout(countdown)
    const pkg = await this.drive.get('/package.json')
    if (pkg === null) throw ERR_INVALID_MANIFEST('Unable to read application package.json')
    const manifest = JSON.parse(pkg.toString())

    const { name, productName, version, upgrade, bin } = manifest
    const appName = productName ?? name
    const home = os.homedir()

    if (bin) {
      const bins = typeof bin === 'string' ? { [name]: bin } : bin
      for (const binName of Object.keys(bins)) {
        const ext = isWindows ? '.msix' : ''
        const dest = isWindows
          ? null
          : to
            ? path.join(to, binName + ext)
            : isMac
              ? path.join('/', 'usr', 'local', 'bin', binName)
              : path.join(home, '.local', 'bin', binName)
        this.targets.push({ filename: binName, ext, dest, isBin: true })
      }
    }

    const ext = isMac ? '.app' : isWindows ? '.msix' : '.AppImage'
    const dest = isWindows
      ? null
      : to
        ? path.join(to, appName + ext)
        : isMac
          ? path.join('/', 'Applications', appName + ext)
          : fs.existsSync(path.join(home, 'Applications'))
            ? path.join(home, 'Applications', appName + ext)
            : fs.existsSync(path.join(home, 'AppImages'))
              ? path.join(home, 'AppImages', appName + ext)
              : path.join(home, '.local', 'bin', appName + ext)

    this.targets.push({ filename: appName, ext, dest, isBin: false })

    const present = new Set()
    const appPath = '/by-arch/' + host + '/app/'
    for await (const name of this.drive.readdir(appPath)) present.add(name)

    const required = only
      ? only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : this.targets.filter((t) => t.isBin || !bin).map((t) => t.filename + t.ext)
    const missing = required
      .filter((r) => !present.has(r))
      .map((name) => plink.serialize({ ...parsed, pathname: appPath + name }))
    if (missing.length) {
      throw ERR_NOT_FOUND('Not found: ' + missing.join(', '))
    }

    this.targets = this.targets.filter(({ filename, ext }) => present.has(filename + ext))

    const exists = []
    const installs = []
    for (const target of this.targets) {
      if (isWindows) {
        const ps = spawnSync('powershell', [
          '-NoProfile',
          '-Command',
          `(Get-AppxPackage '${target.filename}') -ne $null`
        ])
        if (ps.stdout.toString().trim() === 'True') {
          exists.push({ filename: target.filename, dest: target.dest })
          continue
        }
      } else if (fs.existsSync(target.dest)) {
        exists.push({ filename: target.filename, dest: target.dest })
        continue
      }
      installs.push(target)
    }

    if (installs.length === 0) {
      const message = isWindows
        ? `Already installed:\n${exists.map(({ filename }) => '  ' + filename).join('\n')}\n  Manually uninstall first to reinstall`
        : `Refusing to overwrite existing:\n${exists.map(({ dest }) => '  ' + dest).join('\n')}\n  Manually remove first to reinstall`
      throw ERR_EXISTS(message)
    }

    const tmp = path.join(this.base, 'targets')
    fs.mkdirSync(tmp, { recursive: true })
    const prefixes = installs.map(({ filename, ext }) => appPath + filename + ext)
    const mirror = this.drive.mirror(new LocalDrive(tmp), {
      prefix: prefixes,
      prune: false,
      progress: true,
      dedup: true
    })
    const monitor = mirror.monitor()
    monitor.on('update', (stats) => this.emit('stats', stats))
    await mirror.done()
    monitor.destroy()

    let installed = 0
    for (const { filename, ext, dest, isBin } of installs) {
      const key = appPath + filename + ext
      this.emit('app', { app: filename, name, version, upgrade, key, tmp, dest })

      const from = path.join(tmp, 'by-arch', host, 'app', filename + ext)

      if (fs.existsSync(from) === false) {
        throw ERR_NOT_FOUND(plink.serialize({ ...parsed, pathname: key }))
      }

      if (isWindows) {
        const MSIXManager = require('msix-manager')
        await new MSIXManager().addPackage(from)
        installed++
        continue
      }

      if (isBin) {
        try {
          if (!to) fs.mkdirSync(path.dirname(dest), { recursive: true })
          this._move(from, dest)
        } catch (err) {
          if (err.code === 'EACCES' || err.code === 'EPERM') {
            const dir = path.dirname(dest)
            const fix = isMac
              ? `sudo chgrp admin ${dir} && sudo chmod g+w ${dir}`
              : `sudo chown -R "$(id -un):$(id -gn)" ${dir}`
            throw ERR_PERMISSION_REQUIRED(`Permission denied: ${dest}\n  Fix: ${fix}`)
          }
          throw err
        }
        fs.chmodSync(dest, 0o755)
      } else {
        try {
          await fs.promises.rename(from, dest)
        } catch (err) {
          if (err.code === 'EACCES' || err.code === 'EPERM') {
            const dir = path.dirname(dest)
            const fix = isMac
              ? `sudo chgrp admin ${dir} && sudo chmod g+w ${dir}`
              : `sudo chown -R "$(id -un):$(id -gn)" ${dir}`
            throw ERR_PERMISSION_REQUIRED(`Permission denied: ${dest}\n  Fix: ${fix}`)
          }
          throw err
        }
        if (isLinux) await this._linux(dest, filename, tmp, home)
      }
      installed++
    }
    if (installed === 0) {
      throw ERR_UNKNOWN('Failed to install')
    }
    this.emit('final', { success: true, installed, exists })
  }

  async _linux(dest, appName, tmp, home) {
    fs.chmodSync(dest, 0o755)
    const extracted = path.join(tmp, 'squashfs-root')
    const desktopPath = this._extract(dest, extracted, tmp, appName + '.desktop')
    const desktop = fs.readFileSync(desktopPath, 'utf8').replace(/^Exec=.*/m, `Exec=${dest}`)
    fs.writeFileSync(desktopPath, desktop)

    spawnSync(dest, ['--appimage-extract', 'usr/share/icons'], { cwd: tmp })
    const src = new LocalDrive(path.join(extracted, 'usr', 'share', 'icons', 'hicolor'), {
      followLinks: true
    })
    const dst = new LocalDrive(path.join(home, '.local', 'share', 'icons', 'hicolor'))
    const mirror = src.mirror(dst, { prune: false })
    await mirror.done()

    this._move(
      desktopPath,
      path.join(home, '.local', 'share', 'applications', appName + '.desktop')
    )
  }

  _extract(appImage, extracted, cwd, file) {
    const { status } = spawnSync(appImage, ['--appimage-extract', file], { cwd })
    if (status !== 0) throw new Error('appimage-extract failed')
    const full = path.join(extracted, file)
    let stat = null
    try {
      stat = fs.lstatSync(full)
    } catch {}
    if (stat !== null && !stat.isSymbolicLink()) return full
    const link = fs.readlinkSync(full)
    const target = path.resolve(path.dirname(full), link)
    let exists = true
    try {
      fs.lstatSync(target)
    } catch {
      exists = false
    }
    return exists
      ? target
      : this._extract(appImage, extracted, cwd, path.relative(extracted, target))
  }

  _move(src, dst) {
    try {
      fs.renameSync(src, dst)
    } catch (err) {
      if (err.code === 'ENOENT') return // ignore if path does not exist
      if (err.code !== 'EXDEV') throw err
      fs.copyFileSync(src, dst)
      fs.rmSync(src)
    }
  }

  async _close() {
    await this._teardown()
  }

  async _teardown() {
    if (this.doneFinding) {
      this.doneFinding()
      this.doneFinding = null
    }
    if (this.drive) {
      await this.drive.close()
      this.drive = null
    }
    if (this.swarm && this._ownSwarm) {
      await this.swarm.destroy()
      this.swarm = null
    }
    if (this.corestore && this._ownCorestore) {
      await this.corestore.close()
      this.corestore = null
    }
    if (this.base) {
      try {
        fs.rmSync(this.base, { recursive: true, force: true })
      } catch {}
      this.base = null
    }
  }
}

module.exports = Install
