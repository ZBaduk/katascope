# katascope

A desktop app for inspecting the internals of KataGo neural networks: given a
game and a position, show what the trunk is doing at each residual block.

**Status: skeleton.** Both tabs exist and the full stack is wired end to end,
but no features are implemented yet.

## Requirements

Node **>= 22.22.3** (Angular 22's CLI enforces it). `.nvmrc` pins 22.23.1.

KataGo, a model file, and Python are **not** required — the app ships with
fakes and defaults to them.

## Running it

```bash
nvm use          # or otherwise get onto Node >= 22.22.3
npm install
npm run dev
```

That starts Electron with hot reload: renderer edits repaint in place, and
main/preload edits restart the app.

## Using a real KataGo

Copy the config and point it at your install:

```bash
cp katascope.config.json katascope.config.local.json
```

```jsonc
{
  "useFakes": false,
  "katagoPath": "/usr/local/bin/katago",
  "modelPath": "/path/to/b6c96-s175M.bin.gz",
  "katagoConfigPath": "/path/to/analysis.cfg",
  "pythonPath": "python3",
  "sidecarPath": "sidecar/activations.py"
}
```

`katascope.config.local.json` is gitignored. Relative paths resolve against the
repo root; bare names like `katago` and `python3` are looked up on `PATH`.

The Diagnostics tab reports whether each subsystem actually came up. Note that
the Python activation sidecar is not written yet, so with `useFakes: false` the
activation store will report as unavailable.

## Other commands

```bash
npm test           # vitest: core and katago-bridge
npm run typecheck  # all four workspaces
npm run build      # libraries, renderer, Electron bundles
npm run clean
```

## Layout

```
packages/core             pure TypeScript — domain model, SGF, IPC contract
packages/katago-bridge    Node — spawns KataGo and the Python sidecar
packages/ui               Angular — renderer
apps/desktop              Electron — main process, preload, wiring
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for the module boundaries and data flow,
and [CLAUDE.md](CLAUDE.md) for the conventions.
