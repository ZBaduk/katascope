# katascope architecture

katascope is a desktop app for inspecting the internals of a KataGo neural
network: given a game and a position, show what the trunk is doing at each
residual block.

This document covers the module boundaries and the data flow between them. It
describes the skeleton as built; the feature surface is still empty.

## Why the boundaries are where they are

One constraint drives most of the structure: **the interesting code must be
testable without KataGo, without a model file, and without Electron.** A
b6c96 model is hundreds of megabytes and KataGo needs a GPU to be pleasant.
If understanding a position required all of that to be present, most of the
code would be untestable and the UI undevelopable.

So the domain model is a dependency-free library, every external process sits
behind an interface with a fake implementation, and the app defaults to the
fakes. A fresh clone runs, shows both tabs, and serves synthetic activations
with nothing installed.

## Packages

```
packages/core             pure TypeScript  -- domain model, SGF, IPC contract
packages/katago-bridge    Node             -- spawns KataGo and the sidecar
packages/ui               Angular          -- renderer
apps/desktop              Electron         -- main process, preload, wiring
```

### `@katascope/core`

The domain model, and the only package the other three all depend on.

No Angular, no Electron, **no Node built-ins**. Its `tsconfig` sets
`"lib": ["ES2023"]` with no `types`, so an accidental `import { readFile } from
'node:fs'` -- or even a bare `setTimeout` -- fails to compile. That is not
pedantry: it is what lets the same `ActivationFrame` type be the thing the
Python sidecar produces, the thing that crosses the IPC boundary, and the thing
an Angular component renders, with no adapter layers in between.

Contents:

- **Domain types** -- `Board` (immutable, resolves captures), `Move`,
  `GameRecord`, `NetworkSpec` (`{blocks, channels, boardSize}`),
  `ActivationFrame`.
- **`ActivationStore`** -- the interface everything reads activations through.
- **SGF parser** -- FF[4], including compressed point rectangles, escaped
  property values, and variations (the main line is projected onto a
  `GameRecord`; variation trees are parsed but not retained).
- **`FakeActivationStore`** -- synthetic activations for a b6c96 net.
- **Config** -- the shape of `katascope.config.json`, plus parsing and
  validation. Reading the file is the bridge's job, because that needs `fs`.
- **IPC contract** -- see below.

### `@katascope/katago-bridge`

Everything that spawns a process. Node-only; importing it from the renderer
would be a bug, and the boundary that prevents it is Electron's, not
TypeScript's.

Two subsystems, each behind an interface:

| Interface | Live implementation | Fake |
|---|---|---|
| `AnalysisEngine` | `KataGoAnalysisEngine` -- spawns `katago analysis` | `FakeAnalysisEngine` |
| `ActivationStore` (from core) | `SidecarActivationStore` -- spawns a Python sidecar | `FakeActivationStore` (from core) |

Both peers speak newline-delimited JSON over stdin/stdout, so the framing,
request/response correlation, timeouts and crash handling are shared
(`process/line-process.ts`, `process/request-correlator.ts`). If a child dies,
every in-flight request rejects with its exit status and the tail of its
stderr; nothing hangs waiting on a dead process.

`createBridge(config)` is the **only** place that decides fake versus live.
Everything downstream sees the interfaces.

### `@katascope/ui`

The Angular app: standalone components, signals, zoneless change detection,
`OnPush` everywhere. Currently the shell, the router, and two tab components.

It runs in two contexts and must not assume either:

- Inside Electron, where `window.katascope` exists.
- In a plain browser via `ng serve`, where it does not. `KATASCOPE_API` injects
  `null` there, and Diagnostics says so rather than throwing.

Routing is hash-based (`withHashLocation()`). A packaged build is served from
`file://`, which has no origin for path-based routing to resolve against.

### `apps/desktop`

The Electron main process and the preload script. It owns lifecycle, window
creation, and IPC registration -- and nothing else. It does not know what a
residual block is; it wires the bridge to the renderer and stays out of the way.

Main and preload are bundled by esbuild to CommonJS. A sandboxed preload must be
CJS, and keeping main the same avoids running two module systems in one app.
`electron` stays external; the workspace packages are bundled in, so a packaged
app carries no symlinks.

## The IPC contract

`window.katascope` is typed by `KatascopeApi`, which lives in **core** -- not in
`apps/desktop`, and not duplicated in the UI. Three sides consume one
declaration:

```
packages/core/src/ipc/contract.ts
   |
   +-- apps/desktop/src/main/ipc.ts      implements it  (handlers: KatascopeApi)
   +-- apps/desktop/src/preload/index.ts forwards it    (invoke per method)
   +-- packages/ui .../platform/         consumes it    (KATASCOPE_API token)
```

Channel names are keyed by method name and declared
`as const satisfies Record<keyof KatascopeApi, string>`, so a method without a
channel -- or a channel without a method -- does not compile. Both main and
preload iterate `IPC_METHODS` rather than listing channels by hand.

Everything crossing the boundary must survive the structured clone algorithm.
Typed arrays do, which is what makes it reasonable to ship a `Float32Array` of
activations straight to the renderer without serialising to JSON.

### Security posture

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`.
- The preload exposes the four contract methods and never `ipcRenderer` itself,
  so the renderer cannot reach an arbitrary channel.
- Arguments from the renderer are validated in main before reaching a spawned
  process, even though the renderer is our own code.
- Navigation and window-opening are refused; external URLs go to the real
  browser.
- The renderer declares a CSP that forbids remote code.

## Data flow

Loading a game, and reading activations for a position:

```
  SGF file
     |  parseSgf()                        [core, pure]
     v
  GameRecord ----- positionAt(n) -----> Board            [core, pure]
     |
     |  renderer asks for (move, block)
     v
  window.katascope.getActivationFrame({moveNumber, block})    [preload]
     |
     |  ipcRenderer.invoke -> ipcMain.handle
     v
  Bridge.activationStore.frame(key)                       [main]
     |
     +-- fake:  FakeActivationStore -- generates it            [core]
     |
     +-- live:  SidecarActivationStore
                  |  {"type":"frame","moveNumber":..,"block":..}\n
                  v
                Python sidecar (owns the model)
                  |  {"ok":true,"dtype":"float32","min":..,"max":..,"data":"<base64>"}
                  v
                decode -> ActivationFrame
     |
     |  structured clone (Float32Array survives intact)
     v
  ActivationFrame in the renderer -> channelPlane(frame, c) -> heatmap
```

An `ActivationFrame` is every channel of one block's output at one move.
Planes are channel-major, row-major within a channel, so channel `c` occupies
`data[c * area .. (c+1) * area)` and maps 1:1 onto the board's flat cell array.
`uint8` frames carry a `range` so quantised values can be mapped back.

The analysis path is the same shape: renderer -> preload -> main ->
`AnalysisEngine` -> `katago analysis` over JSON lines. No UI consumes it yet.

## Configuration

`katascope.config.json` names the `katago` binary, the model, the KataGo
analysis `.cfg`, the Python interpreter, and the sidecar entry point.

- Resolution order: `katascope.config.local.json` (gitignored, for
  machine-specific paths), then `katascope.config.json` (checked in).
- Read from the repo root in development, from `userData` when packaged;
  `KATASCOPE_CONFIG_DIR` overrides both.
- `useFakes: true` is the default and the reason a fresh clone runs.
- A missing, malformed, or invalid config **never** stops the app from opening.
  It degrades to defaults and reports the problem in Diagnostics. A dev tool
  that refuses to launch because a path is wrong cannot tell you the path is
  wrong.

## Development

`npm run dev` runs three things at once:

1. `tsc --watch` over core and katago-bridge, so a shared type change reaches
   both the renderer and the main process.
2. `ng serve`, which owns renderer hot reload. Electron points at its URL, so a
   component edit repaints without restarting.
3. esbuild watching main and preload. These cannot hot-reload -- the main
   process *is* the app -- so a rebuild restarts Electron. Renderer state is the
   only thing lost, and only when main-process code changed.

Electron is not launched until the dev server answers, so the first window never
loads a connection error.

## Not built yet

- The Python activation sidecar. Its wire protocol is specified in
  `packages/katago-bridge/src/activations/sidecar-protocol.ts`, and
  `SidecarActivationStore` is written against it, but `sidecar/activations.py`
  does not exist. Until it does, `useFakes: false` will report the activation
  store as unavailable in Diagnostics.
- Every feature: the goban, move navigation, channel selection, heatmaps,
  analysis display. Both tabs are placeholders.
- Packaging (`electron-builder` or similar).
