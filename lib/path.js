const fs = require('fs')
const os = require('os')
const path = require('path')
const process = require('process')
const { isMac } = require('which-runtime')

module.exports = (newPath, options = {}) => {
  const { prepend = false } = options

  const resolvedPath = newPath.replace(/^~/, os.homedir())
  const { configFile, shell } = options.shellConfig
    ? {
        configFile: options.shellConfig.replace(/^~/, os.homedir()),
        shell: path.basename(process.env.SHELL)
      }
    : detectShellConfig()

  const content = fs.existsSync(configFile) ? fs.readFileSync(configFile, 'utf8') : ''
  if (content.includes(resolvedPath)) {
    return
  }

  const isFish = shell === 'fish'
  const exportLine = isFish
    ? `\nfish_add_path ${prepend ? '--prepend ' : ''}${resolvedPath}`
    : prepend
      ? `\nexport PATH="${resolvedPath}:$PATH"`
      : `\nexport PATH="$PATH:${resolvedPath}"`

  fs.appendFileSync(configFile, exportLine + '\n', 'utf8')
}

function detectShellConfig() {
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
