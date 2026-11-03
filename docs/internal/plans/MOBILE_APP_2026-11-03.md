# Athena Agents on a phone

*Plan, 3 November 2026, written against `main` at `074b90e`. Nothing here is built yet. This picks up
part C of [REMOTE_APP_PLAN.md](REMOTE_APP_PLAN.md) (parts A and B there are done) and turns it into
steps.*

## Goal

An Android app, then an iOS app, that lets you use the dashboard on your computer from your phone:
answer what **Needs you**, approve or refuse steps, talk to the Brain, agents and teams, follow tasks and
open artifacts. It works on Wi-Fi and on mobile data, without an account, and without opening the
computer to the internet.

The phone is a remote control. The server keeps running on the computer, because it starts agent CLIs,
terminals and a Bun runtime, and a phone can't do that.

## Where things stand

| Area | State at `074b90e` | What it means for the phone |
|---|---|---|
| Talking to the server | Every address, header and socket goes through `web/client/` (`connection.ts`, `http.ts`). `tests/server/web-client-boundary.test.ts` fails if other code writes `/api/`, `fetch(` or `new WebSocket(` | The page doesn't care how it reaches the server. Loaded through a proxy on the phone, nothing in `web/` changes |
| Pages | All React on Base UI except the Station's map and header (three.js, plain DOM) | Phone layouts can go page by page |
| Narrow screens | One breakpoint: `max-md:` is 820 px and less (`web/styles/app.css`). The sidebar is already a drawer (`nav-toggle`, `body.nav-open`), the Station's side panel becomes a bottom sheet, and page padding shrinks. About 48 `max-md:` uses | A start, not a phone app. Chat windows float and are sized from `innerWidth` (`web/chatwin.tsx`). There is no `(hover: none)` handling, no safe-area handling and no long-press for right-click menus |
| Server's guard | Listens on `127.0.0.1` only. `ALLOWED_HOSTS` (Host check), `Sec-Fetch-Site`, `x-dash` on changes, the WebSocket `Origin` check, and a CSP whose `connect-src` is built from the server's own port (`server/index.ts`, around lines 90 and 1340–1460). 228 routes | All of it stays. Phone requests have to arrive as loopback requests that pass these checks, and be marked as coming from a phone |
| Desktop app | Tauri 2 (`src-tauri/`): starts the bundled server with a Bun sidecar; tray, updater, single instance, window state. No IPC with the page | None of that runs on a phone. The mobile app is a different, much smaller shell |
| Net | [`ai-2070/net`](https://github.com/ai-2070/net) v0.46: Rust core, TypeScript SDK (`@net-mesh/sdk` on the native `@net-mesh/core`), nRPC with streaming, join tokens (`net-mesh invite create`), relays that only see encrypted bytes, direct-first with relay fallback, WebRTC browser nodes | The transport. Earlier it was shown to compile for Android arm64, but it has not run on a phone. iOS has not been tried. The Node binding has not been tried under Bun |

## How it fits together

```text
 PHONE (Tauri 2 mobile app)                                YOUR COMPUTER
 ┌──────────────────────────────┐                         ┌──────────────────────────────────────┐
 │ WebView                      │                         │ server/remote/ (Net node, in the      │
 │  loads http://127.0.0.1:P/   │                         │ server process, off by default)      │
 │        │                     │      Net, encrypted     │        │ HTTP / WS over loopback     │
 │        ▼                     │   direct, or relayed    │        ▼                             │
 │ proxy (Rust, 127.0.0.1:P) ◀══╪═════════════════════════╪══▶ same server, same 228 routes      │
 │ Net node, phone's own key    │                         │    on 127.0.0.1:4800 / 14800         │
 └──────────────────────────────┘                         └──────────────────────────────────────┘
```

### Decisions, and why

1. **The page comes from the computer, through the tunnel.** The app bundles only its own screens:
   pairing, "Can't reach your computer" and the lock screen (like `src-tauri/loading`). The phone then
   always shows the page that matches its server, the store app rarely needs an update, and
   `web/` has one build.
2. **The server stays on `127.0.0.1`.** The gateway in `server/remote/` takes requests off Net and sends
   them to the server's own loopback address, with `Host: 127.0.0.1:<port>` and a matching `Origin`. It
   adds `x-dash-device: <device id>` and `x-dash-remote: <token>`. The token is a secret made when
   the server starts, like `internalToken()`. The server's guard reads those two headers:
   - a correct token: the request is from that device, and the device policy applies (below);
   - `x-dash-device` with a wrong or missing token: refused (403);
   - neither: a local request, exactly as today.

   *Not chosen:* calling the routes in-process. Uploads, chat streams and both WebSockets would each
   need a second code path. Forwarding over loopback keeps one.
3. **The computer's Net node runs in the server (TypeScript binding), not in the desktop app's Rust.**
   That way people running `bun run start` get phone access too. The risk is that `@net-mesh/core` is
   a native module. It has to load under Bun, go in `external` in `scripts/build-desktop.ts` and be
   copied in like node-pty. The proof of concept (M0) checks this. If it fails, the fallback is a Net
   node in `src-tauri/src/` that forwards the same way, and then only the desktop app supports phones.
4. **On the phone, a loopback proxy rather than Tauri's custom URL scheme.** Chat answers stream,
   videos ask for byte ranges, and the page holds two WebSockets (`/ws`, `/ws/term`). A real HTTP
   proxy carries all of these unchanged. A custom scheme handler can't take WebSockets, and on
   Android its responses may be buffered rather than streamed. The catch is that other apps on the
   phone can reach `127.0.0.1` too, so the proxy:
   - binds `127.0.0.1` on a random port and checks `Host`;
   - opens the WebView on a one-use start address (`/__start?k=<random>`), which sets an `HttpOnly`,
     `SameSite=Strict` cookie and redirects to `/`;
   - refuses every request without that cookie. `<img src>`, video and downloads send the cookie, so
     nothing in the page changes;
   - makes a new port, key and cookie on every launch.
5. **Not chosen: opening a port on the LAN or using Tailscale.** The server would have to listen past
   loopback, or accept other Host names. It would also need a login and TLS. That weakens the
   boundaries in `AGENTS.md`, and it still wouldn't work on mobile data without more setup.
6. **Later, maybe: the phone's browser with nothing installed.** Net's WebRTC browser nodes could make
   this possible. But every `<img src>`, video and download would have to go through Net, which means
   a service worker. Not in this plan.

## What a phone may do

The computer is where you set things up; the phone is where you keep work moving. Each paired device
gets this policy. It lives in `server/remote/policy.ts` and the server's guard applies it.

| Class | Examples | From a phone |
|---|---|---|
| Read | Anything the page reads with GET, files through `/api/file` (still limited by `insideRoots`) | Allowed |
| Keep work moving | Chat with the Brain, agents and teams; answer questions; approve or refuse; tasks; Outbox review; attach photos and files; start or stop runs and routines | Allowed |
| Changes setup | Agents, teams, skills, routines, settings, MCP servers, programs | Allowed, with a per-device switch *Can change setup* (on by default) |
| Dangerous or computer-only | Terminals (`/ws/term`); keys and account tokens (`/api/secrets…`); deleting or restoring a project; installing skills from GitHub; X and Reddit sign-in (their callbacks go back to the computer's own address); anything under `/api/internal/` | Refused in v1, with "Do this on your computer". Terminals get their own per-device switch later |

- **Every route has a class.** A test lists the server's routes and fails when one has none, so a new
  route is never reachable from a phone by accident.
- Approvals, answers and posts made from a phone are recorded with the device's name ("Approved from
  Pixel 9").
- Routes that open something on the computer (a program, a folder) still work, and the phone page
  labels them "Opens on your computer".
- Secrets still never go to any page, local or remote.

## Pairing and devices

- **Settings › Devices** is a new tab in `web/views/setup.tsx`, backed by `web/views/devices.tsx`.
  The first switch, *Let your phone connect*, is off by default. Turning it on starts the Net node.
  The computer's Net key is kept under `DATA` with the other secrets, and never goes into
  `<project>/.dashboard` or backups.
- **Pair a phone** shows a QR code holding a one-use Net join token (it expires after 10 minutes),
  the computer's node id and the relay's address. The phone scans it with Tauri's barcode-scanner
  plugin, makes its own key in the Android Keystore or iOS Keychain, joins, and asks for a name
  ("My Pixel").
- The device list shows each device with its name, when it was paired, when it was last seen, whether
  it is on a direct or relayed path, and its two switches. **Remove** cuts the device off: its open
  requests and sockets close at once and its token stops working.
- Data: `Device` in `shared/types.ts`, kept in `collection<Device>('devices')` in `store.ts`. Changes go
  out with `emit('devices', …)` so open tabs update.
- One phone can pair with several computers (home, work). The app keeps a list of them and has a
  switcher.

## The relay

Phones on mobile data are often behind carrier NAT, so many sessions will go through a relay. The relay
only forwards encrypted bytes and holds no keys.

- **Recommendation:** an Athena relay we run, used by default. Each device gets a rate limit, and only
  paired nodes may use it. Settings › Devices takes your own relay's address instead (`net-mesh relay
  serve` on any small server).
- M0 measures how often a phone ends up on the relay, on Wi-Fi and on mobile data. Those numbers decide
  what the relay costs to run.

## The phone app

- **A new crate, `src-mobile/`, rather than mobile targets inside `src-tauri/`.** The desktop crate is
  built around the Bun sidecar, `resources/app`, the updater, the tray and single instance, and none of
  that applies on a phone. Keeping them apart keeps both configs and CI simple. Shared Rust, if any
  appears, can become a small library crate later.
- **Rust side:** Net node (`net-mesh-sdk`), the proxy (HTTP/1.1, streaming bodies, WebSocket upgrade,
  each carried over nRPC streaming calls), the list of paired computers, and reconnecting when the app
  comes back to the foreground.
- **Its own screens** (bundled, plain HTML like `src-tauri/loading`): pair by QR, choose a computer,
  "Can't reach your computer" with **Try again** and why (computer asleep, phone access off, removed),
  and an optional lock with the phone's fingerprint or face (biometric plugin). The lock is on by
  default, because the phone holds a key to your agents.
- **Native pieces the page needs:**
  - attachments from the camera and photos (the WebView's file chooser; check it on Android in M0);
  - downloads and `target=_blank` links: open in the system browser or the share sheet, as the desktop
    app sends them to the default browser;
  - safe areas (`viewport-fit=cover`), and the keyboard pushing the composer up
    (`interactive-widget=resizes-content`).
- **Versions:** the gateway sends the server's version and a remote-protocol number. If the phone app
  is too old for the server, or the server too old for the app, it says which one to update.
- **Background:** iOS and Android close sockets in the background. On resume the app reconnects. The
  page's live socket already shows **Reconnecting…** and recovers.

## Notifications

Knowing something needs you while the app is closed is the main reason to have a phone app. It is also
the one part that needs a server we run, because iOS only delivers push through Apple's service (APNs)
and that needs our key.

- **The push carries no content:** "Something needs you on *Home PC*". The app then opens and fetches
  the details over Net. The push service never sees agent output.
- It runs next to the relay. The computer sends a wake-up for its paired devices when an approval,
  question or failed run arrives. These are the same events that open the **Needs you** drawer in
  `web/app.ts` today.
- Android: FCM, or UnifiedPush (ntfy) for people without Google services. iOS: APNs.
- **v1 ships without push.** It notifies only while the app is open. Push comes in M4.

## Phone layouts

These can start now, in parallel with everything else, and be tested in a desktop browser at phone
width before Net works.

In order of what people will do on a phone:

1. **Needs you and the Outbox.** Full-screen sheet, large Approve/Refuse buttons, the question's
   choices as buttons, and the answer box above the keyboard.
2. **Chats** (Brain, agent, team). Below 820 px, show one chat at a time, full screen, with a back
   button and a list of open chats instead of floating windows. Dragging tabs out and **Arrange** are
   hidden on a phone. The composer stays above the keyboard, and the paperclip offers the camera.
3. **Tasks.** The board becomes one column per status, swiped sideways, or a grouped list.
4. **Artifacts and Overview.** Mostly reflow. The 3D viewer works with touch.
5. **Station.** Keep it, but go easy on the battery. On phones use a lower pixel ratio, no voxel
   finishing passes or shadows, and stop drawing when the page is hidden. Long-press opens the right-click menu
   (`stationmenu.tsx`). A list view of teams and agents is the fallback.

Throughout:

- `@media (hover: none)`: anything that only appears on hover is always visible on touch.
- Touch targets at least 44 px. Keyboard hints (`<kbd>`) hidden on touch.
- Pages that don't fit a phone in v1 (Terminals, Programs, MCP setup, the world builder, the workflow
  editor) show what they hold read-only, with "Open this on your computer to change it".

Tests: layout logic (which chat view to use, hiding drag and Arrange) in `tests/web`. Then a manual
check on a small Android phone, a large one and an iPhone before each release.

## Milestones

| | What | Done when | Rough size |
|---|---|---|---|
| **M0** | Proof of concept: `@net-mesh/core` under Bun and inside the desktop bundle; a Tauri Android app with a Net node and the proxy on a real phone; a streamed chat answer, an upload, a video and the `/ws` socket through a relay, then direct; an iOS build of the Rust side | A chat answer streams to a phone on mobile data. We know the share of sessions that stay on the relay | 1–2 weeks |
| **M1** | Server: `server/remote/` gateway, the `x-dash-device`/`x-dash-remote` check, `policy.ts`, `Device` and Settings › Devices, all behind the off-by-default switch. CSP `connect-src` built for the request rather than only from `PORT` | Tests: spoofed device headers refused; every route classed; a removed device cut off mid-stream; local requests behave exactly as today | 1–2 weeks |
| **M2** | Android app: pairing, proxy with the start cookie, the computer list, unreachable and lock screens, attachments, downloads. Internal test track on Play | A second person pairs and uses it without help | 2 weeks |
| **M3** | Phone layouts (starts now, runs alongside M0–M2) | The five areas above work at 360 px wide | 2–3 weeks |
| **M4** | Notifications: push service next to the relay, FCM/UnifiedPush, wake-ups from the server | An approval reaches a locked phone in under 10 seconds | 1–2 weeks |
| **M5** | iOS: Apple developer account, Keychain, APNs, TestFlight | Same as M2, on an iPhone | 1–2 weeks |
| **M6** | Releases: signing keys as CI secrets, a CI job that builds the Android app on Linux and the iOS app on macOS, store listings, privacy answers, `docs/mobile.md`, README and `docs/guide.md` sections | In both stores | 1–2 weeks plus review time |

The sizes are guesses for one person. M0 is the one that can change the plan.

## Open questions

- **Who runs the relay and push service, and who pays?** The recommendation above is that we run them,
  with your own relay as the alternative. Push has no self-hosted path on iOS.
- **The app's name and identifier.** Store identifiers can't change later. The desktop app is still
  `com.ai2070.blacksite`. Should the phone app start as `com.ai2070.athena`?
- **The phone policy.** Is the table above right? In particular: setup changes allowed by default,
  terminals off.
- **App Store review.** An app that mostly shows web content can be rejected as "minimum
  functionality" (guideline 4.2). Pairing, push and the biometric lock are native features that
  usually get such apps through, but it is a risk for iOS only.
- **Net on iOS and under Bun.** Both are untested. M0 answers them.
