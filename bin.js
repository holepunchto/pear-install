#!/usr/bin/env node
const pkg = require('./package.json')
const process = require('process')
const { isWindows } = require('which-runtime')
const { command, arg, bail } = require('paparam')
const { runner } = require('./cmd')

const program = command(
  'install',
  arg('[link]', 'Pear link origin to install from'),
  runner,
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
