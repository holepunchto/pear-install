'use strict'
const test = require('brittle')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const process = require('process')
const tmp = require('test-tmp')
const { isMac, isWindows } = require('which-runtime')
const InstallCmd = require('../cmd')

const PEAR_KEY = 'pear://smw4thqaqed9iq6bae7a9cxd4fesruixgkafe38jny33ahs33igy'
const pearExe = isWindows ? 'pear.exe' : 'pear'

test(
  'e2e installs pear and boots sidecar',
  { skip: isWindows || typeof Bare !== 'undefined' },
  async function (t) {
    t.timeout(900_000)

    // darwin os.tmpdir() (/var/folders/<hash>/T) is 56 chars, leaving no room for
    // HOME: the sidecar's $HOME/Library/Application Support/pear/pear.sock must fit
    // the 103 char unix socket path limit
    const dir = await tmp(t, { dir: isMac ? '/tmp' : undefined })
    const installDir = path.join(dir, 'install')
    const homeDir = path.join(dir, 'home')
    const installedPear = path.join(installDir, pearExe)
    const env = {
      ...process.env,
      HOME: homeDir,
      PATH: `${installDir}${path.delimiter}${process.env.PATH || ''}`
    }
    await fs.promises.mkdir(homeDir, { recursive: true })

    t.comment('install pear')
    await fs.promises.mkdir(installDir, { recursive: true })
    let finalInstall = null
    for await (const event of new InstallCmd({
      link: PEAR_KEY,
      to: installDir,
      timeout: 120_000
    })) {
      if (event.tag === 'final') finalInstall = event.data
    }
    t.ok(finalInstall?.success, 'installed successfully')

    t.comment('run installed pear smoke tests')
    t.ok(fs.existsSync(installedPear), `installed ${installedPear}`)
    const help = await exec(t, installedPear, ['help'], { cwd: dir, env })
    t.ok(help.stdout.includes('pear'), 'help printed')

    t.comment('boot installed sidecar')
    const sidecar = spawn(installedPear, ['sidecar'], {
      cwd: dir,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    t.teardown(() => terminate(sidecar))
    t.teardown(() =>
      shutdownSidecar(t, installedPear, {
        cwd: dir,
        env
      })
    )
    const boot = await waitForOutput(sidecar, /Sidecar Booted/)
    t.ok(boot, 'sidecar booted')
    await shutdownSidecar(t, installedPear, { cwd: dir, env })
    await terminate(sidecar)
  }
)

function exec(t, cmd, args, opts = {}) {
  const timeout = opts.timeout || 300_000
  return new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      terminate(child)
      reject(new Error(`Timed out: ${cmd} ${args.join(' ')}`))
    }, timeout)

    child.stdout.on('data', (data) => {
      stdout += data
    })
    child.stderr.on('data', (data) => {
      stderr += data
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      if (code === 0) return resolve({ stdout, stderr })
      t.comment(stdout)
      t.comment(stderr)
      reject(new Error(`${cmd} ${args.join(' ')} exited with ${code || signal}`))
    })
  })
}

function waitForOutput(child, pattern, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`Timed out waiting for ${pattern}\n${output}`))
    }, timeout)
    const cleanup = () => {
      clearTimeout(timer)
      child.stdout.off('data', ondata)
      child.stderr.off('data', ondata)
      child.off('exit', onexit)
      child.off('error', onerror)
    }
    const ondata = (data) => {
      output += data
      if (!pattern.test(output)) return
      cleanup()
      resolve(output)
    }
    const onexit = (code, signal) => {
      cleanup()
      reject(new Error(`Process exited before output matched: ${code || signal}\n${output}`))
    }
    const onerror = (err) => {
      cleanup()
      reject(err)
    }
    child.stdout.on('data', ondata)
    child.stderr.on('data', ondata)
    child.on('exit', onexit)
    child.on('error', onerror)
  })
}

async function terminate(child) {
  if (!child) return
  try {
    child.kill('SIGTERM')
  } catch {}
  const exited = await waitForExit(child, 5000)
  if (exited) return closeStdio(child)
  try {
    child.kill('SIGKILL')
  } catch {}
  await waitForExit(child, 5000)
  closeStdio(child)
}

function closeStdio(child) {
  child.stdin?.destroy?.()
  child.stdout?.destroy?.()
  child.stderr?.destroy?.()
}

function waitForExit(child, timeout) {
  if (child.exitCode !== null) return true
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.off('exit', onexit)
      resolve(false)
    }, timeout)
    const onexit = () => {
      clearTimeout(timer)
      resolve(true)
    }
    child.once('exit', onexit)
  })
}

async function shutdownSidecar(t, cmd, opts) {
  try {
    await exec(t, cmd, ['sidecar', 'shutdown'], { ...opts, timeout: 30_000 })
  } catch {}
}
