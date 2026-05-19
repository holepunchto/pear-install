'use strict'
const process = require('process')
const Opstream = require('pear-opstream')
const byteSize = require('tiny-byte-size')
const { isWindows } = require('which-runtime')
const pkg = require('./package.json')
const Install = require('.')

const down = isWindows ? '↓' : '⬇'

class InstallCmd extends Opstream {
  static outputs = {
    installing: ({ link }) => `Installing... ${link}`,
    app: ({ app, version, upgrade, dest, key, fork, length }) =>
      `App: ${app}\nVersion: ${version}\nLink: ${upgrade}\nFork: ${fork ?? 'n/a'}\nLength: ${length ?? 'n/a'}\nPathname: ${key}\nTarget: ${dest}`,
    stats({ download, peers }) {
      const dl =
        download.bytes + download.speed === 0
          ? ''
          : ` [ ${down} ${byteSize(download.bytes)} - ${byteSize(download.speed)}/s ] `
      return `[ Peers: ${peers} ]${dl}`
    },
    error: ({ message }) => message,
    final({ success, message }) {
      if (success) return 'Installed'
      return message ?? 'Failed'
    }
  }
  static async output(json, stream) {
    let status = false
    for await (const { tag, data } of stream) {
      if (json) {
        process.stdout.write(JSON.stringify({ cmd: 'install', tag, data }) + '\n')
        continue
      }
      if (!this.outputs[tag]) continue
      const line = this.outputs[tag](data)
      const clear = status ? '\r\x1B[2K' : ''
      if (tag === 'stats') {
        process.stdout.write('\r\x1B[2K' + line)
        status = true
        continue
      }
      process.stdout.write(clear + line + '\n')
      status = false
      if (tag === 'final') return data
    }
  }

  static async runner(cmd) {
    const { json, only, to, dhtBootstrap } = cmd.flags
    const timeout = (cmd.flags.timeout || 30) * 1000
    const link = cmd.args.link ?? pkg.pear.platform.key
    const bootstrap = dhtBootstrap
      ? dhtBootstrap.split(',').map((tuple) => {
          const [host, port] = tuple.split(':')
          const int = +port
          if (Number.isInteger(int) === false) throw new Error(`Invalid port: ${port}`)
          return { host, port: int }
        })
      : undefined
    const stream = new InstallCmd({ link, only, to, bootstrap, timeout })
    await InstallCmd.output(json, stream)
  }

  constructor(params) {
    super((...args) => this.#op(...args), params)
  }

  async #op(opts) {
    const install = new Install(opts)
    install.on('installing', (data) => {
      this.push({ tag: 'installing', data })
    })
    install.on('app', (data) => {
      this.push({ tag: 'app', data })
    })
    install.on('stats', (data) => {
      this.push({ tag: 'stats', data })
    })
    install.on('final', (data) => {
      this.final = data
    })
    try {
      await install.ready()
    } finally {
      await install.close()
    }
  }
}

module.exports = InstallCmd
