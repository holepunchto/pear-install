#!/usr/bin/env node
const pkg = require('./package.json')
const { isWindows } = require('which-runtime')
const { command, arg, bail } = require('paparam')
const InstallCmd = require('./cmd')

const program = command(
  'install',
  arg('[link]', 'Pear link origin to install from'),
  async (cmd) => {
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
  },
  pkg.command,
  bail((info = {}) => {
    process.exitCode = 1
    let message
    if (info.reason === 'UNKNOWN_FLAG') message = 'Unrecognized Flag: --' + info.flag.name
    else if (info.reason === 'UNKNOWN_ARG') {
      message = `Unrecognized Argument at index ${info.arg.index} with value ${info.arg.value}`
    } else message = info.err?.message ?? 'Failed'
    const cross = isWindows ? 'x' : '\x1B[31m✖\x1B[39m'
    console.error(cross, message)
    if (info.reason === 'UNKNOWN_FLAG' || info.reason === 'UNKNOWN_ARG') {
      console.error('\n' + info.command.usage())
    }
  })
)

program.parse(process.argv.slice(2))
