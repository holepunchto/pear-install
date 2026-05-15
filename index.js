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
const Opstream = require('pear-opstream')
const PearError = require('pear-errors')
const byteSize = require('tiny-byte-size')
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

class Install extends Opstream {
  static outputs = {
    installing: ({ link }) => `Installing... ${link}`,
    app: ({ app, version, upgrade, dest, key }) =>
      `App: ${app}\nVersion: ${version}\nLink: ${upgrade}\nPathname: ${key}\nTarget: ${dest}`,
    stats({ upload, download, peers }) {
      const dl =
        download.bytes + download.speed === 0
          ? ''
          : `[ down ${byteSize(download.bytes)} - ${byteSize(download.speed)}/s ] `
      const ul =
        upload.bytes + upload.speed === 0
          ? ''
          : `[ up ${byteSize(upload.bytes)} - ${byteSize(upload.speed)}/s ] `
      return `[ Peers: ${peers} ] ${dl}${ul}`
    },
    error: ({ message }) => message,
    final({ success, message }) {
      if (success) return 'Installed'
      return message ?? 'Failed'
    }
  }

  constructor(params) {
    super((...args) => this.#op(...args), params)
    this.targets = []
  }

  async #op({ link, only, to, bootstrap, timeout = 30_000 }) {
    const parsed = plink.parse(link)
    if (parsed.pathname) throw new Error('Link must not have pathname')
    const host = process.platform + '-' + process.arch
    this.push({ tag: 'installing', data: { link, host } })

    const rand = crypto.randomBytes(16).toString('hex')
    const base = path.join(PEAR_DIR, 'gc', rand)
    fs.mkdirSync(base, { recursive: true })

    const corestore = new Corestore(base)
    const drive = new Hyperdrive(corestore, parsed.drive.key)
    const swarm = new Hyperswarm({ bootstrap })

    let findingDone = null
    try {
      await drive.ready()
      findingDone = drive.findingPeers()
      const topic = swarm.join(drive.discoveryKey, { server: false, client: true })
      swarm.on('connection', (c) => corestore.replicate(c))

      let serving = false
      swarm.dht.on('nat-update', () => {
        if (!swarm.dht.randomized && !serving) {
          serving = true
          swarm
            .join(drive.discoveryKey, { server: true, client: false })
            .flushed()
            .then(() => topic.destroy())
        }
      })
      const deferred = Promise.withResolvers()
      const countdown = setTimeout(() => {
        deferred.reject(ERR_NETWORK_TIMEOUT('Network Timeout ' + timeout / 1000 + 's'))
      }, timeout)
      await Promise.race([drive.core.update({ wait: true }), deferred.promise])
      clearTimeout(countdown)
      const pkg = await drive.get('/package.json')
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
      for await (const name of drive.readdir(appPath)) present.add(name)

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

      const tmp = path.join(base, 'targets')
      fs.mkdirSync(tmp, { recursive: true })
      const prefixes = installs.map(({ filename, ext }) => appPath + filename + ext)
      const mirror = drive.mirror(new LocalDrive(tmp), {
        prefix: prefixes,
        prune: false,
        progress: true,
        dedup: true
      })
      const monitor = mirror.monitor()
      monitor.on('update', (stats) => this.push({ tag: 'stats', data: stats }))
      await mirror.done()
      monitor.destroy()

      let installed = 0
      for (const { filename, ext, dest, isBin } of installs) {
        const key = appPath + filename + ext
        this.push({ tag: 'app', data: { app: filename, name, version, upgrade, key, tmp, dest } })

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
      this.final = { success: true, installed, exists }
    } finally {
      if (findingDone) findingDone()
      await drive.close()
      await swarm.destroy()
      await corestore.close()
      fs.rmSync(base, { recursive: true, force: true })
    }
  }

  static async output(json, stream) {
    for await (const { tag, data } of stream) {
      if (json) {
        process.stdout.write(JSON.stringify({ cmd: 'install', tag, data }) + '\n')
        continue
      }
      if (tag === 'final') {
        process.stdout.write('\r\x1B[2K' + this.outputs.final(data) + '\n')
        return data
      } else if (this.outputs[tag]) {
        process.stdout.write('\r\x1B[2K' + this.outputs[tag](data) + '\n')
      }
    }
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
}

module.exports = async function (cmd) {
  const { json, only, to, dhtBootstrap } = cmd.flags
  const timeout = (cmd.flags.timeout || 30) * 1000
  const link = cmd.args.link
  const bootstrap = dhtBootstrap
    ? dhtBootstrap.split(',').map((tuple) => {
        const [host, port] = tuple.split(':')
        const int = +port
        if (Number.isInteger(int) === false) throw new Error(`Invalid port: ${port}`)
        return { host, port: int }
      })
    : undefined
  const stream = new Install({ link, only, to, bootstrap, timeout })
  await Install.output(json, stream)
}
