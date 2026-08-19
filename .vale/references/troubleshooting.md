<!-- source: https://github.com/vitejs/vite/blob/main/docs/guide/troubleshooting.md -->

# Troubleshooting

See [Rollup's troubleshooting guide](https://rollupjs.org/troubleshooting/) for more information too.

If the suggestions here don't work, please try posting questions on [GitHub Discussions](https://github.com/vitejs/vite/discussions) or in the `#help` channel of [Vite Land Discord](https://chat.vite.dev).

## CLI

### `Error: Cannot find module 'C:\foo\bar&baz\vite\bin\vite.js'`

The path to your project folder may include `&`, which doesn't work with `npm` on Windows ([npm/cmd-shim#45](https://github.com/npm/cmd-shim/issues/45)).

You will need to either:

- Switch to another package manager (e.g. `pnpm`, `yarn`)
- Remove `&` from the path to your project

## Config

### This package is ESM only

When importing an ESM only package by `require`, the following error happens.

> Failed to resolve "foo". This package is ESM only but it was tried to load by `require`.

> Error [ERR_REQUIRE_ESM]: require() of ES Module /path/to/dependency.js from /path/to/vite.config.js not supported.
> Instead change the require of index.js in /path/to/vite.config.js to a dynamic import() which is available in all CommonJS modules.

In Node.js <=22, ESM files cannot be loaded by [`require`](https://nodejs.org/docs/latest-v22.x/api/esm.html#require) by default.

While it may work using [`--experimental-require-module`](https://nodejs.org/docs/latest-v22.x/api/modules.html#loading-ecmascript-modules-using-require), or Node.js >22, or in other runtimes, we still recommend converting your config to ESM by either:

- adding `"type": "module"` to the nearest `package.json`
- renaming `vite.config.js`/`vite.config.ts` to `vite.config.mjs`/`vite.config.mts`

## Dev Server

### Requests are stalled forever

If you are using Linux, file descriptor limits and inotify limits may be causing the issue. As Vite does not bundle most of the files, browsers may request many files which require many file descriptors, going over the limit.

To solve this:

- Increase file descriptor limit by `ulimit`

  ```shell
  # Check current limit
  $ ulimit -Sn
  # Change limit (temporary)
  $ ulimit -Sn 10000 # You might need to change the hard limit too
  # Restart your browser
  ```

- Increase the following inotify related limits by `sysctl`

  ```shell
  # Check current limits
  $ sysctl fs.inotify
  # Change limits (temporary)
  $ sudo sysctl fs.inotify.max_queued_events=16384
  $ sudo sysctl fs.inotify.max_user_instances=8192
  $ sudo sysctl fs.inotify.max_user_watches=524288
  ```

If the above steps don't work, you can try adding `DefaultLimitNOFILE=65536` as an un-commented config to the following files:

- /etc/systemd/system.conf
- /etc/systemd/user.conf

For Ubuntu Linux, you may need to add the line `* - nofile 65536` to the file `/etc/security/limits.conf` instead of updating systemd config files.

Note that these settings persist but a **restart is required**.

Alternatively, if the server is running inside a VS Code devcontainer, the request may appear to be stalled. To fix this issue, see
[Dev Containers / VS Code Port Forwarding](#dev-containers-vs-code-port-forwarding).

### Vite crashes with ENOSPC error

If you see an error like this on Linux:

> Error: ENOSPC: System limit for number of file watchers reached

This happens when you have too many files in your project directory (e.g., many images or assets) and exceed the system's file watcher limit. Linux has a default limit of around 8,192-10,000 file watchers.

To solve this, you can:

- Increase the system file watcher limit:

  ```shell
  # Check current limit
  $ cat /proc/sys/fs/inotify/max_user_watches
  # Increase limit (temporary)
  $ sudo sysctl fs.inotify.max_user_watches=524288
  # Make it permanent - add to /etc/sysctl.conf (or edit if it already exists)
  $ echo "fs.inotify.max_user_watches=524288" | sudo tee -a /etc/sysctl.conf
  $ sudo sysctl -p
  ```

- Exclude directories with many files from file watching using [`server.watch.ignored`](/config/server-options#server-watch)
- Use polling instead of file system events with [`server.watch.usePolling`](/config/server-options#server-watch). Note that polling uses more CPU resources

### Network requests stop loading

When using a self-signed SSL certificate, Chrome ignores all caching directives and reloads the content. Vite relies on these caching directives.

To resolve the problem use a trusted SSL cert.

See: [Chrome issue](https://bugs.chromium.org/p/chromium/issues/detail?id=110649#c8)

#### macOS

You can install a trusted cert via the CLI with this command:

```
security add-trusted-cert -d -r trustRoot -k ~/Library/Keychains/login.keychain-db your-cert.cer
```

Or, by importing it into the Keychain Access app and updating the trust of your cert to "Always Trust."

### 431 Request Header Fields Too Large

When the server / WebSocket server receives a large HTTP header, the request will be dropped and the following warning will be shown.

> Server responded with status code 431. See https://vite.dev/guide/troubleshooting.html#_431-request-header-fields-too-large.

This is because Node.js limits request header size to mitigate [CVE-2018-12121](https://www.cve.org/CVERecord?id=CVE-2018-12121).

To avoid this, try to reduce your request header size. For example, if the cookie is long, delete it. Or you can use [`--max-http-header-size`](https://nodejs.org/api/cli.html#--max-http-header-sizesize) to change max header size.

### Dev Containers / VS Code Port Forwarding

If you are using a Dev Container or port forwarding feature in VS Code, you may need to set the [`server.host`](/config/server-options.md#server-host) option to `127.0.0.1` in the config to make it work.

This is because [the port forwarding feature in VS Code does not support IPv6](https://github.com/microsoft/vscode-remote-release/issues/7029).

See [#16522](https://github.com/vitejs/vite/issues/16522) for more details.

## HMR

<!--
  Trimmed here; 178 more lines upstream. Through the dev-server entries; the HMR ones repeat the same shape.
-->