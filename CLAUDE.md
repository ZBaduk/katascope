# katascope conventions

Read `ARCHITECTURE.md` first for the module boundaries and data flow. This file
is the rules.

## Setup

Node **>= 22.22.3** (Angular 22's CLI enforces it). `.nvmrc` pins 22.23.1; run
`nvm use` if the CLI refuses to start.

```
npm install
npm run dev        # Electron + hot reload
npm test           # vitest: core, katago-bridge, ui
npm run typecheck  # every workspace, sources and tests
npm run build      # libraries, renderer, then the Electron bundles
```

See **Testing strategy** for the rest, including the end-to-end suite and the
Python service.

`ui`, `apps/desktop` and `katago-bridge` resolve `@katascope/*` through those
packages' `exports` fields, which point at `dist/`. So the libraries must be
built before anything can typecheck or test against them. The root `pretest`,
`pretypecheck` and `prepare` hooks handle that -- but it is why running `vitest`
directly inside `packages/katago-bridge` after a `npm run clean` fails until you
run `npm run build:libs`.

## TypeScript

**Strict, and then some.** `tsconfig.base.json` is the source of truth; do not
weaken it per package. Beyond `strict`, the settings that actually change how
you write code:

- `noUncheckedIndexedAccess` -- `array[i]` is `T | undefined`. Handle it; do not
  reach for `!` as the default.
- `exactOptionalPropertyTypes` -- `{ foo: undefined }` is not assignable to
  `{ foo?: string }`. Omit the key instead. There is a helper for this pattern
  in the SGF parser (`optional()`), and the conditional-spread idiom
  (`...(x === undefined ? {} : { x })`) is used throughout the bridge.
- `verbatimModuleSyntax` -- type-only imports need `import type`.
- `noPropertyAccessFromIndexSignature` -- index-signature access uses brackets.
  This is why untrusted JSON is read as `line['moveInfos']`, not `line.moveInfos`.

No `any`. Parse `unknown` at the edges (IPC arguments, JSON from a child
process, config files) and narrow explicitly. Narrowing `unknown` to
`Record<string, unknown>` right after a `typeof` check is the accepted idiom for
reading untrusted JSON and needs no apology. Any cast that actually erases a
type -- the two `as unknown as` / signature-erasing casts in the IPC plumbing --
needs a comment explaining why the compiler cannot see what you can.

Prefer `readonly` on interface fields and `readonly T[]` on array parameters.

## Module boundaries

**No cross-package imports except via package entry points.** Import
`@katascope/core`, never `@katascope/core/src/domain/board.js` and never a
relative path that climbs out of a package. If something needs to be shared,
export it from that package's `index.ts`. Within a package, relative imports
are normal.

The dependency graph is acyclic and stays that way:

```
core  <-  katago-bridge  <-  apps/desktop  ->  ui  ->  core
```

Specifically:

- **`core` depends on nothing.** No Angular, no Electron, no Node built-ins, no
  npm runtime dependencies. Its `tsconfig` has no `types` and `lib: ["ES2023"]`,
  so a `node:fs` import or a bare `setTimeout` fails to compile. If you need a
  platform capability in core, you are in the wrong package -- or you inject it
  (see `delay()` in `fake-activation-store.ts`).
- **`katago-bridge` is Node-only** and must never be imported from `ui`.
- **`ui` never imports `katago-bridge`.** It reaches the Node side only through
  `window.katascope`, typed by the contract in core.
- **No UI feature work in `core`.** No formatting for display, no colour
  mapping, no component-shaped helpers. Core answers "what is true about this
  position"; the UI decides how it looks.

## Adding an IPC method

The contract in `packages/core/src/ipc/contract.ts` is the single source of
truth. To add a method:

1. Add it to the `KatascopeApi` interface.
2. Add its channel to `IPC_CHANNELS`. The `satisfies
   Record<keyof KatascopeApi, string>` makes this non-optional -- it will not
   compile otherwise.
3. Implement it in the `handlers: KatascopeApi` object in
   `apps/desktop/src/main/ipc.ts`. Preload needs no change; it iterates
   `IPC_METHODS`.

Rules for anything crossing the boundary:

- It must survive structured clone. Typed arrays and plain objects do; class
  instances, functions and `Map`s do not.
- At most one argument, and it is **untrusted**. Validate it in main before it
  reaches a spawned process, as `parseActivationKey` does.
- Never expose `ipcRenderer` to the renderer.

## Angular

- Standalone components only. No `NgModule`.
- Signals for state: `signal`, `computed`, `input()`, `resource()`. No
  `BehaviorSubject` for component state.
- Zoneless. `zone.js` is not a dependency -- do not add it, and do not write
  code that depends on zone patching (`setTimeout` will not trigger change
  detection).
- `ChangeDetectionStrategy.OnPush` on every component.
- Built-in control flow (`@if`, `@for`, `@let`). No `*ngIf` / `*ngFor`.
- **Never `@if (someNumber(); as x)`.** The alias form tests truthiness, and `0`
  is a perfectly good channel index, block index, move number and reader norm.
  This shipped three times: channel 0 rendered as "no channel selected", so the
  top-left tile of every block was uninspectable; a change overlay comparing
  against move 0 reported "no earlier position"; and a channel nothing reads
  showed no reader-norm row at all. Write `@if (value() !== undefined)` for any
  signal that can legitimately hold zero.
- Selector prefix `ks-`.
- Tabs are lazily routed. A feature area's code should not land in the initial
  bundle just by existing.
- The renderer may run without the bridge (`ng serve` in a browser tab). Inject
  `KATASCOPE_API`, handle `null`, do not assume Electron.
- Component styles are scoped by default; leave them that way. Global tokens
  live in `src/styles.css` and are used as `var(--ks-*)`.

## Testing strategy

### The rule

**No feature is merged without tests at the level of its own package.** Not
"tests somewhere"; tests in the package that owns the behaviour. A parser change
is tested in `core`, a protocol change in `katago-bridge`, a store change in
`ui`, a feature-encoding change in `activation-service`. An end-to-end test is
not a substitute for any of them -- it tells you the wiring works, never that
the logic is right.

**Rendering logic is split into pure functions plus thin drawing code.** Any
normalization, thresholding, colour mapping, layout arithmetic, or hit-testing
lives in a pure module that takes numbers and returns numbers, with a unit test.
What remains is a canvas call that reads the result and paints it, and that part
carries no decisions worth testing. A component that computes *and* draws is not
acceptable: nobody can verify a heatmap by looking at it, and "it looked right
on my machine" is not a regression test.

Applies to activation heatmaps, the goban, and anything else that ends up on a
canvas.

### Commands

```
npm test            # vitest across core, katago-bridge and ui; @katago specs skip
npm run test:ci     # the same, with @katago specs excluded by glob (what CI runs)
npm run test:e2e    # builds, then drives the real app with Playwright
npm run typecheck   # sources *and* tests, every workspace
```

Python, separately:

```
cd tools/activation-service
python3.12 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

Tests are typechecked, not just transpiled. Each TypeScript package has a
`tsconfig.spec.json` that its `typecheck` script runs. Vitest only transpiles,
so without this a test can reference a field that no longer exists and pass.

### `packages/core` — vitest

The package that should be thoroughly tested; it is pure, so there is no excuse.

**Every parser, codec and store needs unit tests.** That is a hard requirement,
not a preference: these are the components where a bug produces plausible-looking
wrong output rather than a crash.

- Fixtures live in `fixtures/`, loaded through `test/support/fixtures.ts` and
  never via a hand-built relative path. See `fixtures/README.md`.
- SGF fixtures cover handicap, `AB`/`AW` setup with a compressed rectangle,
  resignation, both pass encodings, variations, a non-square board, and a
  malformed file. `sgf-fixtures.spec.ts` classifies every file in the directory
  and fails if a new fixture is not accounted for -- a fixture no test reads is
  how coverage rots.
- The `.kact` codec lives here, with `fixtures/kact/tiny-b2c3.kact` as a real
  file on disk. The codec tests decode it, re-encode it, and assert the bytes
  are **identical** -- an encoder and decoder that agree with each other but not
  with the format on disk is what a same-process round trip cannot catch. Any
  codec added later gets the same treatment, plus rejection tests for truncated
  and corrupt input.
- **Region-search scoring** (`activation/region-search.ts`) is tested here
  rather than in `ui`, because it decides a claim nobody can check by eye: a
  grid of heatmaps looks equally plausible whatever the scores say. The
  degenerate cases carry the weight -- a dead plane, a constant plane, an empty
  region, a region covering the whole board -- along with the two properties the
  design rests on: that the score is scale-invariant, and that it takes the
  region's minimum rather than its mean.
- `FakeActivationStore` **plants** channels that respond to a known region, so
  "the search finds them" is a deterministic assertion rather than a hope about
  noise. Their indices are all >= 3, because `fixtures/kact/tiny-b2c3.kact` is a
  byte-exact 3-channel fixture generated from the same function; a spec asserts
  that too, so planting inside its range cannot silently rewrite the fixture.

- Test files live in `test/`, named `*.spec.ts`, and import from
  `../src/index.js` -- the same entry point consumers use.

### `packages/katago-bridge` — vitest

Two tiers, and the distinction matters.

**Unit tests** run against a *scripted process*: a real child process with real
pipes whose far end replays a recorded transcript from
`fixtures/transcripts/`. Mocking `child_process` would test the mock; the code
under test here is framing, request correlation, and what happens when a child
dies, none of which a mock exercises.

Each test gets a throwaway executable shim and points `katagoPath` or
`pythonPath` at it, so the engine spawns it exactly as it would spawn the real
binary -- argv included, which the tests assert. See
`test/support/scripted-process.ts` and `fixtures/transcripts/README.md`.

Transcripts cover the happy paths and, more usefully, the ugly ones: non-JSON
banner noise on stdout, a mid-request crash with stderr worth reporting, a
request that is never answered, a frame whose size contradicts the declared
network, an unaligned float payload. Add a transcript rather than a mock.

**Integration tests** against a real binary are tagged `@katago`, live in
`*.katago.spec.ts`, and **skip** -- never fail -- when no `katago`, model and
analysis config are configured. Configuration comes from the same
`katascope.config.json` the app uses, so pointing the app at KataGo enables
them. Run them with `npm run test:katago -w @katascope/katago-bridge`.

These cover what a scripted transcript cannot: that the query katascope builds
is one KataGo accepts, that the fields it reads are ones KataGo sends, that
`restart()` leaves the object usable, and -- the one the golden test leans on --
that the engine is **deterministic** under `configs/analysis-deterministic.cfg`.
If that last test fails, every measured tolerance elsewhere is meaningless.

Skipping is deliberate. A red suite on a laptop that was never going to have a
GPU teaches people to ignore red.

### `tools/activation-service` — pytest

The Python service that reads model internals. Still a scaffold; the tests are
written first because they are what decides whether the implementation is
correct.

**The golden test is the correctness oracle for feature encoding.** For each
fixture position it compares the Python model's raw policy and ownership heads
against `katago`'s own raw-net output (analysis engine, `maxVisits: 1`,
`includePolicy`, `includeOwnership`) within tolerance.

**One tolerance, 1e-4, for every position**, move history included. Measured
agreement is ~1e-6 -- float32 rounding -- so the tolerance is headroom for a
different net or backend, not for a known disagreement.

**Tolerances are measured, never guessed.** `measure_agreement.py` prints the
real numbers; re-run it after any change to the feature path, the vendored
KataGo code, or the engine config, and update the constants in `test_golden.py`
to match. A tolerance nobody has ever seen fail is not a test.

**A wide tolerance hides a mystery.** This suite briefly ran with a 0.2 policy
tolerance and a documented story about KataGo's C++ and Python feature code
disagreeing irreconcilably about history planes. The real cause was
`ignorePreRootHistory`, which the analysis engine defaults to true and which
makes it evaluate the root with no history at all. When the evidence says
"unfixable", enumerate what the *reference* is doing differently before
believing it.

One position (`pass-would-end-game`) is excluded and asserted separately: when a
pass would end the game KataGo deliberately hides history from the net. That
exclusion is bounded in both directions, so it fails if the divergence grows or
if upstream removes it.

This is the most important test in the repository. Activations only mean
something if the position that produced them was encoded the way KataGo encodes
it. A transposed board, an off-by-one in the history planes, the wrong side to
move, a flipped ownership sign -- each yields activations that look entirely
plausible and are entirely wrong, and nothing downstream can tell. **No
activation may be trusted until the golden test passes.**

Alongside it, a shape test asserts the block and channel counts read *from the
model* match the emitted frames, and that a frame flattens to the channel-major,
row-major layout the TypeScript side slices by hand.

Both skip when KataGo and the checkpoint are unconfigured. Note there are two
model artefacts and they gate different things: `modelPath` (`.bin.gz`) is the
C++ engine's, `checkpointPath` (`.ckpt`) is the service's. Details in
`tools/activation-service/tests/README.md`.

**The head re-implementation is the second thing pinned to the model.** The
"reduce" feature needs KataGo's output heads re-run on an altered trunk tensor,
so `@katascope/core` carries a TypeScript port of them. `test_head_golden.py` is
what makes that port trustworthy: it runs the exported weights through a numpy
reference and compares against the model's own head output. Measured agreement
is 3.7e-7; the tolerance is 1e-4. That reference also generates the TypeScript
fixture, so the chain is model -> numpy -> fixture -> TypeScript and never
closes on itself. A head that is subtly wrong -- a missing mask, the pooled
branch omitted, the wrong activation -- returns a perfectly plausible policy,
and nothing downstream can tell.

**Never reimplement the feature encoding.** The vendored KataGo code under
`tools/activation-service/vendor/` is the only encoder; if it needs a fix, fix
it there and say so in `vendor/README.md`. An independent encoding would be
wrong in ways only this test can see.

### `packages/ui` — vitest via `ng test`

The Angular `@angular/build:unit-test` builder with the vitest runner, so the
whole JavaScript side runs on one framework. `src/test-providers.ts` installs
zoneless change detection in the TestBed -- a component that only passes under
zone.js is a component that does not work in this app.

What gets tested here:

- **`SessionStore`** -- move clamping, cache behaviour, eviction, capture
  handling, and that a response arriving after a newer request is discarded
  rather than shown.
- **Board geometry** -- layout, hit-testing, star points, coordinate labels.
  Obviously-right code that is quietly off by one, and miserable to verify from
  a picture.
- **Overlay maths** -- top-N policy selection and ownership colour mapping,
  pure and extracted from the canvas per the rule above.
- **Components** at the seams: the API token returning `null` outside Electron,
  Diagnostics rendering a failed subsystem as failed rather than absent, and the
  Board tab not analysing until an overlay is switched on.

- **Channel grid layout** -- tile sizing, the channel-to-rectangle map, and the
  hit-testing inverse under zoom and pan. The inverse lives next to the forward
  transform on purpose: an inverse that lives somewhere else is one that drifts.
- **Activation normalization and statistics** -- per-channel ranges, percentile
  clipping, thresholds, the change mask and the hide-unused rule.
- **Which frame the change overlay compares against** -- the same side to move,
  not the previous position, because KataGo's planes are perspective-relative
  and the flip otherwise dominates the delta. Keyed on the player, not parity.
- **The rules, in `core`** -- captures, suicide, simple ko, and that a generated
  move is always legal. Nothing downstream re-checks: an illegal move from the
  reduced net would be appended to the record and sent to the sidecar as a
  position that cannot exist.
- **The play loop** (`PlaySession`) -- that the bridge is told before the board
  advances, that a move chosen for a position the game has left is discarded,
  and that the same selection plays the same game twice. The last one is what
  makes a difference between two games attributable to the selection.
- **The channel selection and the reduction it drives** (`ReduceStore`) -- what
  each selection button produces, that a cancelled run cannot land, and that the
  cache is keyed on the head, the mode, the move and the selection. A cache
  keyed on too little would serve a policy computed for a different selection,
  which looks entirely plausible and is entirely wrong.
- **Cross-highlighting in the detail drawer** -- that the pointer over the
  enlarged plane, the pointer over the board beside it and the grid's own hover
  resolve to one shared coordinate, and in the right precedence. Both canvases
  read that single value, so the test asserts the value rather than the pixels.
- **The search driver** (`ChannelSearch`) -- which frames a scope and block
  filter actually read, that a cancelled search stops asking for more, that a
  frame arriving after cancellation cannot land in the table, that a newer
  search supersedes an older one, and that the frame budget truncates visibly.
  The scoring it calls is core's; what is tested here is everything around it.
- **The channel orderings** -- impact (`sum|activation| x reader norm`),
  attribution (`sum|activation x gradient|`), and how each ranks. The head-lean
  classifier normalises both heads before comparing, or a head with larger
  weights throughout would tint every channel the same way and say nothing.

No `it.todo` remains.

**Defects found by looking at a screenshot rather than by a test**: coordinate
labels drawn on the page background instead of the wood; a `<select>` showing
`1` while five markers were drawn; the activation grid growing past the viewport
so the detail pane sat off screen; and the Board tab's board overflowing the
window after its layout moved from grid to flex -- every assertion still passed,
because every element existed and every number was right, and the board was
simply twice the height of the window. A further one -- the statistics effect
not depending on the network spec, so per-channel ranges were never computed --
showed up as a status line missing a phrase, which no assertion was looking for.
All now have regression tests, and the lesson keeps holding: pure functions
catch arithmetic, and nothing but your eyes catches "this looks wrong".

That last one has a corollary worth stating, since it will recur: under emulated
encapsulation a rule like `.page > *` compiles to
`.page[_ngcontent] > *[_ngcontent]`, specificity (0,3,0), which outranks a plain
`.board-area[_ngcontent]` at (0,2,0). A blanket child rule will therefore quietly
beat the specific rule that is supposed to win. Size the flexible item by name
and leave its siblings at their defaults.

### `e2e` — Playwright driving Electron

One smoke test over the **built** app: it is the only test that exercises main,
preload, IPC and the renderer together, so it should exercise what ships.

It opens the app, checks both tabs, switches to Diagnostics, confirms the
subsystem rows came over IPC, and confirms a `Float32Array` survives the
boundary as a `Float32Array`. It also asserts the preload exposes exactly the
contract methods and that neither `require` nor `ipcRenderer` leaked onto
`window` -- the security posture, as a test rather than a comment.

Each launch gets its own `userData` directory. The app takes a single-instance
lock keyed on that path, so without it a developer's running copy makes the
whole suite fail at launch.

The steps that need features -- load a fixture SGF, step moves, select a block
-- are `test.fixme`. They report as expected failures rather than quietly not
existing. **Un-fixme each one in the commit that adds the feature it names.**

Playwright drives Electron's own binary, so no browser download is needed.

### CI

`.github/workflows/ci.yml`, five jobs: `typecheck`, `test`, `build`, `e2e`
(under `xvfb`), and `python`.

**CI runs everything except `@katago` tests.** They are excluded by glob in
`test:ci` as well as skipping on their own, so that exclusion is a deliberate
property of the workflow rather than a side effect of the runner having no
KataGo installed.

The Python job runs a suite in which every test skips. That is on purpose:
collection errors, import errors and syntax errors are real failures, and this
is what catches them. A follow-up step fails the job if collection ever returns
nothing, so the suite cannot silently empty itself.

## Fakes

Every external process sits behind an interface with a fake. `createBridge` is
the only place that chooses between them, driven by `config.useFakes`.

Keep it that way: a fresh clone with no KataGo, no model and no Python must
still launch, show both tabs, and serve activations. If you add a subsystem that
shells out, it needs an interface and a fake in the same commit.

Fakes generate deterministic, clearly-not-real data. `FakeActivationStore`
produces the same frame for the same `(seed, move, block)` so UI work is
reproducible -- the values are shaped to look like trunk activations and mean
nothing.

## Failure handling

The app must open. A missing binary, an unreadable model, a malformed config, a
sidecar that will not start -- all of these surface in Diagnostics, none of them
prevent a window. A tool that will not launch cannot tell you why it will not
launch.

Child processes fail loudly and locally: in-flight requests reject with the exit
status and stderr tail. Never leave a caller awaiting a dead process.

## Style

- British or American spelling, consistently within a file; the existing code
  leans British in prose.
- Comments explain *why*, not *what*. A comment restating the code is noise; one
  explaining a protocol quirk, a performance trade-off, or a deliberate
  limitation earns its place.
- Module-level doc comments say what a module is for and what it deliberately
  does not do.
- Keep `ARCHITECTURE.md` current when a boundary moves. It is the document that
  makes the package split legible to someone who did not write it.
