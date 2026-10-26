# The desktop app

The desktop app (`src-tauri/`, [Tauri 2](https://tauri.app)) is a window around the same server and
page that `bun run start` runs. The page doesn't know it is in an app: it talks to its server over
`127.0.0.1` exactly as in a browser. There is no Tauri IPC, so the page gets no extra permissions.

## How it works

The installed app carries three things:

| What | Where it comes from | Installed as |
|---|---|---|
| The window (Rust) | `src-tauri/src/main.rs` | the app's executable |
| The Bun runtime | Bun's GitHub release for the target, same version as the Bun that builds | a sidecar next to the executable (`bun` / `bun.exe`) |
| The dashboard | `scripts/build-desktop.ts` (below) | `resources/app/` |

`scripts/build-desktop.ts` fills `src-tauri/app/` (git-ignored). Tauri runs it before every
`tauri dev` and `tauri build`:

- **The server, bundled** into `server/index.js` and `server/mcp-bridge.js` with `Bun.build`, so the app doesn't ship
  `node_modules` (about 500 MB). `BRIDGE_SCRIPT` in `server/util.ts` picks the `.js` bridge when it exists.
- **The page**: `public/` after `bun run build`, without source maps.
- **`skills/` and `library/`**, which the server reads from its own folder.
- **The terminal's native module** (`@lydell/node-pty` and its package for the target OS and CPU). It is
  installed from `bun.lock` into `src-tauri/target/desktop-cache/`, so cross-builds get the right one.
- **The Bun runtime** for the target, checked against Bun's `SHASUMS256.txt` and cached in the same folder.
  x64 uses Bun's *baseline* build, which runs on CPUs without AVX2. Offline, a build for this machine
  falls back to the Bun that is running.

When it opens, the app:

1. Picks a port: 4800 if free (X and Reddit apps are registered with it), else 4801–4809, else any.
2. Starts `bun resources/app/server/index.js --port <port> --no-open` with `DASH_DATA` set to the app's
   data folder (unless `DASH_DATA` is already set) and `DASH_DESKTOP=1`. Output goes to `server.log` in
   the app's log folder.
3. Shows `src-tauri/loading/index.html` until the port answers, then loads `http://localhost:<port>/`.
   If the server stops, the same page shows the error, the log's location and **Try again**.
4. On macOS and Linux, asks the login shell for its `PATH`. Apps opened from the Dock or a menu get a
   short one, and agents' CLIs (`claude`, `codex`, `gh`…) would not be found.

Quitting closes the server's stdin. With `DASH_DESKTOP` set, the server takes that as "stop" (in
`server/index.ts`), so it also stops if the app crashes. After 5 seconds the app kills it.

The window only shows the dashboard and its start page. Other `http(s)`/`mailto` links and every new
window (`target=_blank`, `window.open`) open in the default browser; other schemes (`file:`…) are dropped.
A second launch focuses the open window. Size and position are remembered.

### Keep in mind when changing the server

- Everything the server imports must bundle with `Bun.build` (`target: 'bun'`). Native modules can't be
  bundled: add them to `external` in `build-desktop.ts` and copy them like node-pty.
- Files the server reads relative to `ROOT` must be copied into the app by `copyStatic()`. `VENDOR` paths in
  `server/index.ts` (`node_modules/...`) count too.
- The app's folder is read-only once installed (Program Files, the macOS app bundle, the AppImage).
  Write only under `DATA` or the user's folders.
- `bun run desktop:smoke` (after `bun scripts/build-desktop.ts`) runs the bundled server like the app does.
  CI runs it on every change.

## Build it yourself

You need [Rust](https://rustup.rs) and, on Linux, [Tauri's system libraries](https://tauri.app/start/prerequisites/#linux).
On Windows, the WebView2 runtime comes with Windows 10 and 11.

```sh
bun install
bun run desktop:dev                     # build in debug and open the app
bun run desktop:build                   # installers in src-tauri/target/release/bundle/
bunx tauri build --target x86_64-apple-darwin   # another target (on macOS, also aarch64-apple-darwin)
```

Supported targets are listed in `scripts/desktop-target.ts`. A target's Rust toolchain must be
installed (`rustup target add <triple>`). Windows arm64 can be built on Windows x64 with Visual Studio's
ARM64 build tools. Linux arm64 is built on an arm64 machine. A universal macOS build isn't supported:
build the two Macs separately.

The app's version is `package.json`'s `version`.

## CI and releases

- **`ci.yml`, job "Desktop app"** (Linux and Windows, every push and PR): stages the app, runs the smoke
  test and checks the Rust code (`cargo fmt`, `clippy`). It doesn't build installers.
- **`desktop.yml`** builds installers for Windows (x64, arm64), macOS (Apple silicon, Intel) and Linux
  (x64, arm64; `.deb`, `.rpm`, AppImage). Run it from the Actions tab to get them as artifacts.

To release: set `version` in `package.json`, merge, then push a matching tag:

```sh
git tag v0.3.0 && git push origin v0.3.0
```

`desktop.yml` builds every target and puts the installers in a **draft** release. Check it, then publish.
If one target fails, nothing is released.

### Signing (not set up yet)

The installers are unsigned. Windows SmartScreen warns, and macOS asks to allow the app under
**Privacy & Security**. The macOS app is ad-hoc signed (`signingIdentity: "-"`), without which Apple
silicon Macs say a downloaded app is "damaged".

- **macOS**: with an Apple Developer ID, add the certificate and notarization secrets
  (`APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY`, `APPLE_ID`, `APPLE_PASSWORD`,
  `APPLE_TEAM_ID`) as env on the "Build the app" step. See [Tauri's guide](https://tauri.app/distribute/sign/macos/).
  `src-tauri/Entitlements.plist` already allows what Bun and node-pty need under the hardened runtime.
- **Windows**: see [Tauri's guide](https://tauri.app/distribute/sign/windows/) (for example Azure Trusted Signing
  through `bundle.windows.signCommand`).

Mobile (iOS, Android) is out of scope: the dashboard runs agent CLIs and a Bun server, which phones can't.
