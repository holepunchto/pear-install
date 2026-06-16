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
    this.state = null
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
    const parsed = this._parseLink(link)
    const host = process.platform + '-' + process.arch
    this.emit('installing', { link, host })

    await this._openDrive({ bootstrap, timeout, parsed })
    this.state = await this._readManifestState()
    const { bin, name } = this.state
    const appPath = '/by-arch/' + host + '/app/'
    const present = await this._readDriveContents(appPath)

    this.targets = this._resolveTargets()
    this._assertRequiredTargets({
      appPath,
      hasBin: !!bin,
      only,
      parsed,
      present,
      targets: this.targets
    })
    this.targets = this.targets.filter(({ filename, ext }) => present.has(filename + ext))

    const { exists, toInstall } = this._partitionTargets(this.targets, name)

    const tmp = await this._mirrorTargets(appPath, toInstall)
    const installed = await this._installTargets({ appPath, host, toInstall, parsed, tmp })

    this.emit('final', { success: true, installed, exists })
  }

  _parseLink(link) {
    const parsed = plink.parse(link)
    if (parsed.pathname) throw new Error('Link must not have pathname')
    return parsed
  }

  async _openDrive({ bootstrap, timeout, parsed }) {
    const rand = crypto.randomBytes(16).toString('hex')
    this.base = path.join(PEAR_DIR, 'gc', rand)
    fs.mkdirSync(this.base, { recursive: true })

    if (this._ownCorestore) this.corestore = new Corestore(this.base)
    if (this._ownSwarm) this.swarm = new Hyperswarm({ bootstrap })

    this.drive = new Hyperdrive(this.corestore.session(), parsed.drive.key)

    await this.drive.ready()
    this.doneFinding = this.drive.findingPeers()
    this.swarm.join(this.drive.discoveryKey, { server: false, client: true })
    this.swarm.on('connection', (c) => this.corestore.replicate(c))

    await this._waitForUpdate(timeout)
  }

  async _waitForUpdate(timeout = this.timeout) {
    const deferred = Promise.withResolvers()
    const countdown = setTimeout(() => {
      deferred.reject(ERR_NETWORK_TIMEOUT('Network Timeout ' + timeout / 1000 + 's'))
    }, timeout)

    await Promise.race([this.drive.core.update({ wait: true }), deferred.promise])
    clearTimeout(countdown)
  }

  async _readManifestState() {
    const pkg = await this.drive.get('/package.json')
    if (pkg === null) throw ERR_INVALID_MANIFEST('Unable to read application package.json')
    const manifest = JSON.parse(pkg.toString())
    const { name, productName, version, upgrade, bin } = manifest
    const home = os.homedir()
    return {
      appName: productName ?? name,
      bin,
      home,
      localAppData: process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'),
      name,
      upgrade,
      version
    }
  }

  _resolveTargets() {
    const { appName, bin, home, localAppData, name } = this.state
    const to = this.to

    const targets = []

    if (bin) {
      const bins = typeof bin === 'string' ? { [name]: bin } : bin
      for (const binName of Object.keys(bins)) {
        const ext = isWindows ? '.exe' : ''
        const dest = to
          ? path.join(to, binName + ext)
          : isWindows
            ? path.join(localAppData, 'Programs', appName, binName + ext)
            : path.join(home, '.local', 'bin', binName)
        targets.push({ filename: binName, ext, dest, isBin: true })
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

    targets.push({ filename: appName, ext, dest, isBin: false })
    return targets
  }

  async _readDriveContents(appPath) {
    const present = new Set()
    for await (const name of this.drive.readdir(appPath)) present.add(name)
    return present
  }

  _assertRequiredTargets({ appPath, hasBin, only, parsed, present, targets }) {
    const required = only
      ? only
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      : targets
          .filter((target) => target.isBin || !hasBin)
          .map(({ filename, ext }) => filename + ext)

    const missing = required
      .filter((name) => !present.has(name))
      .map((name) => plink.serialize({ ...parsed, pathname: appPath + name }))

    if (missing.length) throw ERR_NOT_FOUND('Not found: ' + missing.join(', '))
  }

  _partitionTargets(targets, name) {
    const exists = []
    const toInstall = []

    for (const target of targets) {
      if (target.ext === '.msix' ? this._hasInstalledMsix(name) : fs.existsSync(target.dest)) {
        exists.push({ filename: target.filename, dest: target.dest, ext: target.ext })
        continue
      }

      toInstall.push(target)
    }

    if (toInstall.length === 0) {
      const lines = exists.map(({ filename, dest }) => '  ' + (dest ?? filename))
      const header = isWindows ? 'Already installed:' : 'Refusing to overwrite existing:'
      throw ERR_EXISTS(
        `${header}\n${lines.join('\n')}\nTo reinstall, manually remove then rerun command`
      )
    }

    return { exists, toInstall }
  }

  _hasInstalledMsix(name) {
    const escName = name.replace(/'/g, "''")
    const ps = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `$null -ne (Get-AppxPackage -Name '${escName}' -ErrorAction SilentlyContinue)`
    ])
    return ps.stdout.toString().trim() === 'True'
  }

  async _mirrorTargets(appPath, toInstall) {
    const tmp = path.join(this.base, 'targets')
    fs.mkdirSync(tmp, { recursive: true })

    const mirror = this.drive.mirror(new LocalDrive(tmp), {
      prefix: toInstall.map(({ filename, ext }) => appPath + filename + ext),
      prune: false,
      progress: true,
      dedup: true
    })
    const monitor = mirror.monitor()
    monitor.on('update', (stats) => this.emit('stats', stats))
    await mirror.done()
    monitor.destroy()

    return tmp
  }

  async _installTargets({ appPath, host, toInstall, parsed, tmp }) {
    let installed = 0
    const exes = new Set()

    for (const target of toInstall) {
      await this._installTarget({ appPath, exes, host, parsed, target, tmp })
      installed++
    }

    for (const dest of exes) this._exe(path.dirname(dest))

    if (installed === 0) throw ERR_UNKNOWN('Failed to install')

    return installed
  }

  async _installTarget({ appPath, exes, host, parsed, target, tmp }) {
    const { filename, ext, dest, isBin } = target
    const {
      state: { home, name, upgrade, version }
    } = this
    const key = appPath + filename + ext
    const verlink = plink.serialize({ drive: this.drive.core })

    this.emit('app', {
      app: filename,
      name,
      version,
      upgrade,
      verlink,
      key,
      tmp,
      dest
    })

    const from = this._installSource(tmp, host, filename, ext)
    if (fs.existsSync(from) === false) {
      throw ERR_NOT_FOUND(plink.serialize({ ...parsed, pathname: key }))
    }

    if (ext === '.msix') {
      const MSIXManager = require('msix-manager')
      await new MSIXManager().addPackage(from)
      return
    }

    if (ext === '.exe') exes.add(dest)

    if (isBin) {
      this._installBin({ dest, from })
      return
    }

    await this._installApp({ dest, filename, from, home, tmp })
  }

  _installBin({ dest, from }) {
    try {
      if (!this.to) fs.mkdirSync(path.dirname(dest), { recursive: true })
      this._move(from, dest)
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') throw this._permissionRequired(dest)
      throw err
    }

    fs.chmodSync(dest, 0o755)
    if (!isWindows) this._addToPath(path.join(os.homedir(), '.local', 'bin'))
  }

  async _installApp({ dest, filename, from, home, tmp }) {
    try {
      await fs.promises.rename(from, dest)
    } catch (err) {
      if (err.code === 'EACCES' || err.code === 'EPERM') throw this._permissionRequired(dest)
      throw err
    }

    if (isLinux) await this._linux(dest, filename, tmp, home)
  }

  _installSource(tmp, host, filename, ext) {
    return path.join(tmp, 'by-arch', host, 'app', filename + ext)
  }

  _permissionRequired(dest) {
    return ERR_PERMISSION_REQUIRED(`Permission denied: ${dest}\n`)
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

  _exe(dir) {
    const read = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      "[Environment]::GetEnvironmentVariable('Path', 'User')"
    ])
    if (read.status !== 0) {
      const err = (read.stderr || '').toString().trim()
      throw new Error('Failed to read User PATH: ' + (err || 'powershell exit ' + read.status))
    }
    const current = read.stdout.toString().replace(/\r?\n$/, '')
    const entries = current ? current.split(';').filter(Boolean) : []
    if (entries.includes(dir)) return false
    const next = (current ? current + ';' : '') + dir
    const escNext = next.replace(/'/g, "''")
    const write = spawnSync('powershell', [
      '-NoProfile',
      '-Command',
      `[Environment]::SetEnvironmentVariable('Path', '${escNext}', 'User')`
    ])
    if (write.status !== 0) {
      const err = (write.stderr || '').toString().trim()
      throw new Error('Failed to update User PATH: ' + (err || 'powershell exit ' + write.status))
    }
    this.emit('path', { dir })
    return true
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
    this.state = null
  }

  _addToPath(newPath) {
    const { configFile, shell } = this._detectShellConfig()

    const isFish = shell === 'fish'
    const exportLine = isFish ? `\nfish_add_path ${newPath}` : `\nexport PATH="$PATH:${newPath}"`

    const content = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
    if (process.env.PATH.split(':').includes(newPath) || content.includes(exportLine)) {
      return
    }

    fs.appendFileSync(configFile, exportLine + '\n', 'utf8')
  }

  _detectShellConfig() {
    const home = os.homedir()
    const shell = path.basename(process.env.SHELL)

    const configCandidates = {
      zsh: ['.zshrc', '.zprofile'],
      bash: isMac
        ? ['.bash_profile', '.bashrc', '.profile']
        : ['.bashrc', '.bash_profile', '.profile'],
      fish: ['.config/fish/config.fish'],
      ksh: ['.kshrc', '.profile'],
      tcsh: ['.tcshrc', '.cshrc'],
      csh: ['.cshrc', '.tcshrc'],
      sh: ['.profile']
    }

    const candidates = configCandidates[shell] ?? ['.profile']
    const existing = candidates.find((f) => fs.existsSync(path.join(home, f)))
    const configFile = path.join(home, existing ?? candidates[0])

    return { configFile, shell }
  }
}

module.exports = Install
