> Install Pear and Pear Applications

## CLI

The published binary. With no `link`, installs the Pear platform. With a `pear://` link, installs that application and/or its binaries.

```sh
npx pear-install [link]
```

### Flags

- `--to <dir>` — target directory (overrides platform default)
- `--only <paths>` — comma-separated filenames to install
- `--timeout <seconds>` — network timeout (default `30`)
- `--dht-bootstrap <nodes>` — comma-separated `host:port`
- `--json` — newline-delimited JSON output (one `{ cmd: 'install', tag, data }` per line)

### Default install destinations

- **macOS** — apps to `/Applications`, bins to `/usr/local/bin`
- **Linux** — apps to `~/Applications`, `~/AppImages`, or `~/.local/bin`; bins to `~/.local/bin`
- **Windows** — apps installed as MSIX packages; bins (`.exe`) to `%LOCALAPPDATA%\Programs\<app>\` with the install directory added to the User `PATH`

## API

```js
const Install = require('pear-install')
```

### `const install = new Install(opts)`

- `link` _(string)_ — `pear://` link
- `to` _(string, optional)_ — target directory
- `only` _(string, optional)_ — comma-separated filenames
- `bootstrap` _(array, optional)_ — `[{ host, port }, ...]` DHT nodes
- `timeout` _(number, optional)_ — milliseconds, default `30000`
- `corestore` _(Corestore, optional)_ — inject an existing corestore; not closed by `install.close()`
- `swarm` _(Hyperswarm, optional)_ — inject an existing swarm; not destroyed by `install.close()`

If `corestore` or `swarm` is omitted, `Install` creates and owns its own.

### `await install.ready()`

Runs the install. Throws on failure.

### `await install.close()`

Releases the drive, the owned swarm and corestore, and removes the temp dir.

### Reusing a corestore and swarm

```js
const corestore = new Corestore('./store')
const swarm = new Hyperswarm()
swarm.on('connection', (c) => corestore.replicate(c))

for (const link of links) {
  const install = new Install({ link, corestore, swarm })
  await install.ready()
  await install.close()
}

await swarm.destroy()
await corestore.close()
```

### Events

- `installing` → `{ link, host }`
- `app` → `{ app, name, version, upgrade, verlink, key, dest }`
- `stats` → `{ download, upload, peers }`
- `path` → `{ dir }` — Windows only; emitted when a bin directory is appended to the User `PATH`
- `final` → `{ success, installed, exists }`

## Web Bootstrap Shell Scripts

The `pear.sh` and `pear.ps1` files are for installing pear over HTTPS for zero external dependency setup.

On macOS and Linux:

```sh
curl install.pears.com/pear.sh | sh
```

On Windows, PowerShell:

```powershell
irm install.pears.com/pear.ps1 | iex
```

The shell scripts be used as boilerplates for other projects by updating `base` variable to your own domain that you'll host the shell scripts on, update the `name` variable and rename the file to the name of your project.

## Command Integration: `/cmd`

For embedding in another CLI. Wraps `Install` as a `pear-opstream` of `{ tag, data }` records with stdout formatters.

```js
const InstallCmd = require('pear-install/cmd')

const stream = new InstallCmd({ link, to, only, bootstrap, timeout })
await InstallCmd.output(json, stream)
```

### Tags

- `installing` → `{ link, host }`
- `app` → `{ app, name, version, upgrade, verlink, key, dest }`
- `stats` → `{ download, upload, peers }`
- `path` → `{ dir }` — Windows only
- `error` → `{ code, message, stack, info, success: false }`
- `final` → `{ success, installed, exists }`

### `await InstallCmd.output(json, stream)`

Drains `stream` to STDOUT.

- `json` truthy — emits each record as `{ cmd: 'install', tag, data }`, newline-delimited.
- `json` falsy — formats per-tag; `stats` updates in place via ANSI; static tags stack above.

Returns the `final` record.

### `await InstallCmd.runner(cmd)`

Pass directly as a [paparam](https://github.com/holepunchto/paparam) command runner. Creates `InstallCmd` instance and passes it to `InstallCmd.output`

- `cmd` is a [paparam](https://github.com/holepunchto/paparam) `cmd` instance

## License

Apache-2.0
