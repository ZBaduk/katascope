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
tools/activation-service  Python           -- reads model internals (scaffold)
e2e                       Playwright       -- drives the built app
```

Testing is documented in `CLAUDE.md` rather than here, but its shape follows
these boundaries: each package is tested at its own level, external processes
are tested against recorded transcripts, and the one suite that crosses every
boundary at once lives in `e2e`.

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
`OnPush` everywhere.

**`SessionStore` is the app's shared state** -- which game is open and which
move is selected -- and it is `providedIn: 'root'` so there is exactly one
answer to "which position are we looking at". Stepping a move on the Board tab
moves the Diagnostics tab with it; neither tab knows about the other. It also
owns the two lazy caches (analysis for the board overlays, activation frames for
the channel grid), because caching, cancellation and eviction are the same
problem in both cases: a reply for a move the user has already left is discarded
rather than drawn, or holding an arrow key down repaints the board with whatever
happened to arrive last.

**Rendering is pure functions plus thin canvas code**, per CLAUDE.md. Every
decision about where something goes lives in `board/board-geometry.ts` and
`activation/grid-layout.ts` (layout, hit-testing, star points, coordinate
labels, zoom and pan); every decision about what colour lives in
`board/overlays.ts` and `activation/normalization.ts`. The canvas components are
`ctx` calls in a sensible order and hold no arithmetic worth testing. That split
is why a 13x9 board, a click two-thirds of the way into a cell, and a hit-test
under zoom and pan are covered by assertions rather than by looking at a
screenshot.

**The activation grid renders in a worker.** A b18c384 block is 384 channels of
361 cells; normalising and colouring all of it is a few million operations, and
doing that on the main thread between arrow-key presses is how a grid stops
feeling like one. `activation/render.worker.ts` returns one RGBA buffer per
frame, transferred rather than copied, and the main thread does `drawImage` per
visible tile. Measured on the reference net, stepping a move costs about 10 ms
of main thread -- one frame.

The worker is an optimisation, not a dependency: `ActivationRenderer` falls back
to running the same `render-core` functions inline when a `Worker` cannot be
constructed, which is a real possibility in a packaged build served from
`file://` and a certainty under jsdom. The view says which path it is on.

**Three orderings, and they disagree.** The grid can sort by change, by
*impact*, or by *attribution*, and which one is right depends on the question:

- **impact** is `sum|activation| x reader norm`. A channel only matters to the
  extent something downstream reads it, and the weight slice its consumer
  applies bounds how much it can influence anything whatever its activation
  happens to be. Static per network, one multiply per channel on top of data
  already in hand, so it is cheap enough to leave on. Reader norms come from
  each block's consumer: the next block's first convolution, or -- for the last
  block, which the heads read instead -- one vector per head.
- **attribution** is `sum|activation x gradient|` for a chosen output. Exact for
  the position asked about, and it costs a forward and a backward pass in the
  service to obtain. The target is chosen on the **Board tab** by clicking an
  intersection, which is why it lives in `SessionStore`: picked on one tab, read
  on the other.

The two heads do not agree about which channels matter: on
kata1-b18c384nbt the policy and value heads' reader norms correlate at **0.13**.
That is why the last block gets a head selector and why its tiles are tinted by
which head reads them -- green for policy-leaning, purple for value-leaning,
untinted for shared. Tinting anything else would be meaningless, since every
other block has exactly one reader.

Neither is available from a `.kact` capture: it holds stored planes, has no
weights to measure and cannot be differentiated. `readerWeights` and `attribute`
are therefore **optional** on `ActivationStore`, and the UI degrades -- impact
falls back to raw loudness, attribution is disabled -- rather than assuming.

**Reduce re-runs a head with channels removed.** The Diagnostics grid can tick
channels of the **last block** and ask what the head would have said with only
those, or without them. The answer cannot be read off any output: the head puts
a non-linearity and a global pool between its input and anything observable, so
the only way to get it is to run the head again. `@katascope/core` therefore
carries a pure TypeScript implementation of both heads, and the sidecar exports
the weights to drive it (`head_weights`, about 260 KiB, fetched once).

Confined to the last block on purpose. It is the block the heads read, so it is
the only one where zeroing a channel has a defined effect on a head; any other
block would need the rest of the trunk re-run as well.

Three decisions in that implementation are worth knowing, because each would
produce a plausible wrong answer if taken the other way:

- **Zeroing happens at the head input**, after the trunk's final normalisation
  and activation -- not on the trunk tensor the tiles display. Zeroing a trunk
  channel does *not* silence it: the final norm adds a per-channel bias and the
  activation maps that bias to something non-zero, so a "removed" channel would
  still push a constant into every convolution reading it.
- **The board mask is explicit.** A frame is the network's full extent, and a
  13x13 game sits in its top-left corner with real but meaningless numbers
  around it. The pooled branch divides by the *on-board* count, so treating a
  13x13 game's frame as 361 cells would scale every pooled feature by 169/361
  and quietly move the pass logit.
- **The pass logit comes from the pooled branch alone.** A reduction that only
  touched the spatial path would move every board logit and leave the pass
  untouched, which looks right until someone checks.

Correctness rests on a chain rather than on inspection, because a wrong head
produces an entirely plausible policy. `test_head_golden.py` runs the exported
weights through a numpy reference and compares against the model's own head
output on seven positions -- worst disagreement **3.7e-7**, which is float32
rounding. That reference then generates `fixtures/heads/tiny-head.json`, which
the core spec checks the TypeScript against. The chain ends at the network, not
at an opinion.

The output is shown as three boards -- full, reduced, and their difference --
always all three. The reduced output alone is uninterpretable: a policy that
likes a corner means one thing if the full head liked it too and quite another
if the reduction invented it.

**The reduced network can be played.** The reduce panel answers "what would the
head have said here"; playing answers "what would it *do*", by feeding the
head's own move back in and going again. A channel set that looks plausible on
one position tends to give itself away over twenty.

Per move: fetch the last block's frame, re-run the policy head with the current
selection, take the best **legal** move, append it. The legality filter is not
optional -- the head knows nothing about the rules, and an illegal move would be
appended to the record and sent to the sidecar as a position that cannot exist.
`domain/play.ts` carries what a generator needs: captures, suicide and simple
ko. Positional superko is **not** implemented; the gap is a long-cycle
repetition, which needs the whole position history rather than the previous
move.

Moves are chosen **greedily, never sampled**. A reduced head is being compared
against a full one, and two runs that differed because of a random draw would be
indistinguishable from two runs that differed because of the reduction. The same
selection plays the same game every time, so a difference between two games is a
difference between two selections.

Playing is what made `setGame` an IPC method. Everything downstream turns a move
number into a position using the record the **main process** holds, so a played
move has to reach main before a frame for the new position is asked for --
`SessionStore.playMove` awaits the bridge before it advances the board. It is
also the one handler whose argument is a whole domain object rather than a
handful of numbers, so it is validated field by field in main before it reaches
a spawned Python process.

Speed is bounded by the sidecar, not by the loop: a forward pass per move. The
delay control exists to slow a fast source down to something watchable, never to
speed a slow one up.

**The detail drawer cross-highlights.** The enlarged plane and the board beside
it are the same 19x19 grid drawn two ways, and the drawer's job is to let
someone check a claim about a place -- "this channel is looking at the
bottom-left corner". So the two canvases share one point of interest, which any
of three things can name: the pointer over the plane, the pointer over the
board, or the pointer over a tile up in the grid. Resolving them in one computed
means the two canvases cannot disagree about where the pointer is, and neither
has to know about the other. The plane's own hit-test lives in `grid-layout`
beside the grid's, because an inverse kept away from its transform drifts.

The Diagnostics tab also steps the game itself. The grid follows the selected
move, and before that button existed the loop for comparing positions was: Board
tab, one step, Diagnostics tab, look, repeat.

**The region search asks "which channels care about *here*".** A set of
intersections is selected on the Board tab -- again in `SessionStore`, picked on
one tab and consumed on the other -- and every channel of every searched frame is
scored against it. The scoring is in `@katascope/core`
(`activation/region-search.ts`), so it is the same arithmetic wherever it runs,
and `ChannelSearch` is the driver that decides which frames to feed it.

Two choices in the scoring are worth knowing:

- **Per-plane z-normalisation.** Trunk magnitudes differ by an order of
  magnitude between block 0 and block 17, and between channels within a block.
  A threshold in raw units would mean something different for every plane it is
  compared against, so one slider position would select half of one block and
  nothing of another. Working in standard deviations from each plane's own mean
  makes one threshold mean one thing everywhere.
- **`min` over the region, not `mean`.** "All high" means every point of the
  region is high; a mean would let one blazing intersection carry four dead
  ones, which is exactly the false positive the feature exists to avoid. The
  price is that the score is set by the region's weakest point.

The optional `specific` flag adds a second condition -- `mean|z|` outside the
region below a ceiling -- turning "fires here" into "fires here and nowhere
else", which is a much stronger claim and a much smaller result set.

Scope follows what the source can afford. A `.kact` capture serves frames from
disk, so a search can cover every move it holds; the live sidecar runs a forward
pass per frame, so it covers the current move only and the panel says so. Either
way there is a frame budget, and the UI reports when it bit rather than
presenting a truncated search as a complete one.

Results come two ways because they answer different questions: ranked by score,
which is "where was this strongest", and summarised per channel by how many
moves it qualified on, which is "which channels do this consistently". The
second matters -- one spectacular score is usually the position, and a channel
that keeps qualifying is the finding -- and it loses the score ranking to
whichever single move happened to spike. Clicking either jumps to that move and
block and pins the channel.

**The change overlay compares against the same side to move, not the previous
position.** KataGo's input planes are relative to whoever is on move -- feature
1 is "my stones", feature 2 is "theirs" -- so consecutive positions have every
stone swapped between those planes. That relabelling propagates through the
trunk and swamps the change the new stone actually caused.

Measured on kata1-b18c384nbt at move 5, the delta against the previous position
was **4.5x** the delta against two positions back at block 0, 2.7x at block 8
and 1.6x at block 17 -- despite two-back being two stones further away -- with
376 of 384 channels moving more against the previous position. Almost all of
that was the perspective flip.

So the overlay walks back to the nearest earlier frame with the same player to
move, which in an ordinary game is two moves back. It is keyed on the player
rather than on parity, because a handicap game starts with White and an SGF need
not alternate, and on the frames the source actually holds, because a capture
may be sparse. The status line names the move it is comparing against.

**The grid normalises per channel across the whole game**, not per move. Per-move
scaling is the obvious choice and it is wrong here: a channel that fires hard at
move 10 and goes quiet at move 60 would look identical at both, because each
frame would be rescaled to fill the same range. Comparing moves is the point of
the tab. Getting a fixed range means reading many of the game's frames for the
block, so it is lazy, cached per block, and **sampled** -- a capture can afford
64 frames from disk, the live sidecar runs a forward pass per frame and gets 12.
The view reports the count, because "normalised over 12 of 240 moves" is a
materially weaker claim than "normalised over the game".

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
                  |  {"type":"frame","block":..,"position":{...}}\n
                  v
                activation service (owns the model)
                  |  {"ok":true,"min":..,"max":..,"binaryBytes":N}\n<N raw bytes>
                  v
                decode -> ActivationFrame
     |
     |  structured clone (Float32Array survives intact)
     v
  ActivationFrame in the renderer -> channelPlane(frame, c) -> heatmap
```

### The activation service

Python, and deliberately small. It loads a KataGo **training checkpoint**
(`.ckpt`) with KataGo's own `model_pytorch` code, vendored under
`tools/activation-service/vendor/`, and reads trunk activations out of KataGo's
own instrumentation -- `model_pytorch` already reports `trunk_after_block{i}`
through its `ExtraOutputs` mechanism, so there are no forward hooks.

Using KataGo's code rather than a reimplementation is the whole point. The input
feature encoding is intricate -- ladder detection, area scoring, history planes,
a dozen rules globals -- and an independent version would be subtly wrong in
ways only the golden test could find, and only after someone had trusted the
output for a while.

Two artefacts, not one: `modelPath` is the `.bin.gz` the C++ engine reads, and
`checkpointPath` is the `.ckpt` the service reads. KataGo converts one way only
(checkpoint to `.bin.gz`), so both are needed and both must be the same network.

The service is **stateless**: every request carries its whole position, so there
is no session for the two sides to disagree about. It keeps one memo of the last
forward pass, keyed by the position itself, so asking for eighteen blocks of one
position does not run the network eighteen times.

### Transport

Control messages are JSON lines. A frame response is a JSON header line followed
immediately by its raw float32 bytes, because a b18c384 frame is 554 KiB and
base64 inside JSON would inflate it by a third and copy it three more times.
`FramedProcess` reads that two-mode stream; `LineProcess` still serves KataGo,
which is pure JSON.

### `.kact` captures

`@katascope/core` owns the container: a header, an index, and float16 planes.

**A capture embeds the SGF it was taken from.** It is a copy rather than a path
reference, and deliberately so: a capture without its game is a pile of numbers
with no positions attached -- the move slider has nothing to label and the board
beside an enlarged plane has no stones. A path would break the moment the file
moved or was sent to someone else, and would break silently: the capture would
still open, just with no board. An SGF is a few kilobytes against a capture of
tens of megabytes.

`KactActivationStore` reads one lazily. Core cannot open a file, so the bytes
arrive through a `KactByteSource`; the bridge supplies a file-handle
implementation and tests supply an array, which keeps the seek-and-decode logic
in core where it is testable without a filesystem. Opening reads the header and
index only; each frame is one ranged read of exactly its own bytes. `openKact`
makes the capture the active activation source, and `getStatus` then reports the
activation store's mode as `capture` -- a third state, not a flavour of `live`:
the numbers are real but they were computed earlier, by a model that may no
longer be configured, and the app cannot ask it anything new.
**float32 in memory and over IPC, float16 on disk** -- half the size for about
3.3 decimal digits, which is far more than a heatmap resolves. The index records
every frame's byte range so a reader can seek to one `(move, block)` without
parsing the rest, and `planKact` lays a whole file out in advance so `npm run
dump` can stream a capture larger than memory.

An `ActivationFrame` is every channel of one block's output at one move.
Planes are channel-major, row-major within a channel, so channel `c` occupies
`data[c * area .. (c+1) * area)` and maps 1:1 onto the board's flat cell array.
`uint8` frames carry a `range` so quantised values can be mapped back.

The analysis path is the same shape: renderer -> preload -> main ->
`AnalysisEngine` -> `katago analysis` over JSON lines. The Board tab's ownership
and policy overlays are its first consumer.

`openSgf` is the one handler that touches the filesystem on the renderer's
behalf. It shows the dialog, reads and **parses the SGF in main**, hands the
`GameRecord` back, and gives the same record to the activation service. Parsing
once rather than shipping the text for the renderer to parse again is
deliberate: main needs the record anyway to drive the engine, and two parses are
two chances to disagree about what the file says. Cancelling returns `null`,
which is not an error and must not unload the open game.

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

## Determinism

The golden test compares the service against the engine numerically, which only
means anything if the engine is reproducible. `configs/analysis-deterministic.cfg`
makes it so, and every setting there exists for that reason:

- `nnRandomize = false` -- otherwise each evaluation picks one of 8 dihedral
  symmetries and the same position gives different numbers every run.
- `rootNumSymmetriesToSample = 1`, `rootSymmetryPruning = false` -- no averaging
  over symmetries at the root.
- `policyOptimism = 0`, `rootPolicyOptimism = 0` -- the subtle one. KataGo
  defaults these to 1.0 and 0.2 for analysis, which geometrically blends the raw
  policy toward the net's *optimistic* policy head. The result is visibly
  flatter than a forward pass and is not what PyTorch produces.
- `reportAnalysisWinratesAs = SIDETOMOVE` -- this governs the sign of
  **ownership** as well as winrate.
- `ignorePreRootHistory = false` -- the analysis engine defaults this to
  **true**, which sets `maxHistory = 0` for the root evaluation, so the reported
  policy and ownership are computed with no move history however many moves the
  query supplied. Sensible for judging a position on its own merits; wrong for
  comparing against a forward pass that encodes the history it was given.

  **This matters to the app, not only to the golden test.** The Board tab's
  ownership and policy overlays come from the engine while the activation
  heatmaps come from the service; with the default on, the two would describe
  different positions -- same stones, different history -- and nothing on screen
  would say so. So `KataGoAnalysisEngine` sends
  `overrideSettings: { ignorePreRootHistory: false }` on **every query** rather
  than trusting `katagoConfigPath`, which is the user's file and may well be
  KataGo's stock `analysis_example.cfg`. The checked-in
  `configs/analysis-deterministic.cfg` sets it too, so the setting is visible
  where someone would look for it; the override is what makes it a guarantee.
- One analysis thread, one search thread.

Under this config the activation service and the engine agree to float32
rounding (~1e-6) on every fixture position. The one exception is deliberate on
KataGo's part: when a pass would end the game, `NNInputs` hides the history from
the net and KataGo's Python feature code does not.

Two things are stated explicitly on the wire rather than inferred, because the
two implementations inferred them differently:

- **`initialPlayer`.** With handicap stones and no moves, nothing in the
  position says whose turn it is. The service assumed Black; the engine inferred
  White. Ownership came back at correlation **-0.90**.
- **`whiteHandicapBonus: 0`.** Chinese rules carry `whiteHandicapBonus = N`,
  silently adding the handicap stone count to White's komi. The komi katascope
  sends must be the komi the network sees.

## Not built yet

- Packaging (`electron-builder` or similar).
- Comparing two positions, or two blocks, side by side. The store already caches
  per `(move, block)`, so the data is there; nothing presents it.
- Writing a capture from the app. `npm run dump` is the only way to make a
  `.kact`.

