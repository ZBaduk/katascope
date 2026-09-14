# katascope conventions

Read `ARCHITECTURE.md` first for the module boundaries and data flow. This file
is the rules.

## Setup

Node **>= 22.22.3** (Angular 22's CLI enforces it). `.nvmrc` pins 22.23.1; run
`nvm use` if the CLI refuses to start.

```
npm install
npm run dev        # Electron + hot reload
npm test           # vitest, core and katago-bridge
npm run typecheck  # all four workspaces
npm run build      # libraries, renderer, then the Electron bundles
```

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
- Selector prefix `ks-`.
- Tabs are lazily routed. A feature area's code should not land in the initial
  bundle just by existing.
- The renderer may run without the bridge (`ng serve` in a browser tab). Inject
  `KATASCOPE_API`, handle `null`, do not assume Electron.
- Component styles are scoped by default; leave them that way. Global tokens
  live in `src/styles.css` and are used as `var(--ks-*)`.

## Tests

**vitest.** `core` and `katago-bridge` have suites; run `npm test` from the
root.

- `core` is the package that should be thoroughly tested -- it is pure, so
  there is no excuse. New domain logic, parser behaviour, or store behaviour
  arrives with tests.
- In `katago-bridge`, test the pure edges: wire encoding, response decoding,
  config resolution, and the fake/live selection in `createBridge`. Do not write
  tests that need a real KataGo binary or a GPU.
- Test files live in `test/`, named `*.spec.ts`, and import from the package
  entry point (`../src/index.js`) -- the same boundary consumers use.
- No test framework in `ui` or `apps/desktop` yet. If you add UI tests, use
  vitest and say so here.

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
