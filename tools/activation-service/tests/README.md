# activation-service tests

These tests decide whether the service is correct. They were written before it
existed, which is why they test the encoding rather than whatever the
implementation happened to do.

```bash
cd tools/activation-service
python3.12 -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest
```

With nothing configured all tests skip, and the header says why:

```
katago: not configured: modelPath (unset), katagoConfigPath (unset)
model: not configured: modelPath (unset)
activation_service.IMPLEMENTED: False
```

## What gates what

Two independent things can be missing, and they gate different suites.

| Needs | Suite | Skips when |
|---|---|---|
| a `katago` binary + `.bin.gz` + analysis cfg | `test_raw_net_oracle.py` | KataGo unconfigured |
| a `.ckpt` only | `test_shapes.py` | no checkpoint |
| both | `test_golden.py` | either is missing |

There are **two model artefacts** and they are not interchangeable:

- `modelPath` — a `.bin.gz`/`.txt.gz`, which only the C++ engine reads.
- `checkpointPath` — a `.ckpt`, which only KataGo's Python code reads.

KataGo converts one way only (checkpoint → `.bin.gz`), so both are needed and
both must be the same network. Get a `.ckpt` from the `model_zip_file` of a
network on katagotraining.org; older (2020-era) runs shipped TensorFlow
`saved_model` archives instead and cannot be used.

Configuration is read from the repo's own `katascope.config.json` /
`katascope.config.local.json`, so pointing the app at KataGo enables these too.

## `test_golden.py` — the correctness oracle

This is the important one.

Activations are only meaningful if the position that produced them was encoded
the way KataGo encodes it. A transposed board, an off-by-one in the history
planes, the wrong side to move, a flipped ownership sign — every one of these
yields activations that look completely plausible and are completely wrong.
Nothing downstream can detect that. A heatmap of garbage is still a heatmap.

So the test runs the same positions through both implementations and compares
the two heads that are spatial, and therefore sensitive to exactly those errors:

- **policy** — full distribution within tolerance, the top move exactly, and the
  legality mask exactly. The mask is the orientation check: a transposed board
  keeps the same *set* of illegal points but moves them.
- **ownership** — values within tolerance, plus a correlation check that fails
  on an inverted sign convention even when magnitudes agree.

The reference comes from `katago analysis` with `maxVisits: 1`,
`includePolicy` and `includeOwnership` — the network's own output with
essentially no search on top.

**No activation may be trusted until this passes.**

### The oracle is itself tested

`test_raw_net_oracle.py` checks that `KatagoRawNet` reads KataGo correctly —
head shapes, a policy that sums to 1 over legal moves, occupied points marked
illegal at the right coordinates, a symmetric policy on the empty board. A
golden test measured against a broken oracle is worse than none.

These need only KataGo, so they run long before the Python side exists.

### Tolerances — measured, not guessed

One tolerance, `1e-4`, for policy and ownership on every position in the tight
set. Run `measure_agreement.py` for the real numbers; they come from there and
nowhere else.

Measured against `kata1-b18c384nbt-s9996604416-d4316597426` on a Metal build of
KataGo v1.16.4:

| position | policy | ownership | corr |
|---|---|---|---|
| empty-19x19 | 0.0000005 | 0.0000012 | 1.0000 |
| opening-4-moves | 0.0000010 | 0.0000019 | 1.0000 |
| handicap-4-setup-stones | 0.0000006 | 0.0000013 | 1.0000 |
| with-passes | 0.0000005 | 0.0000020 | 1.0000 |
| small-9x9 | 0.0000012 | 0.0000015 | 1.0000 |
| rectangular-13x9 | 0.0000006 | 0.0000015 | 1.0000 |
| *pass-would-end-game* | *0.0183455* | *0.0269432* | *0.9955* |

That is float32 rounding. The two implementations agree.

`1e-4` is headroom for a different network or backend, not for a known
disagreement — measured is two orders of magnitude inside it. If a change pushes
a position above 1e-6, something has moved and is worth understanding before the
tolerance is touched.

### The one deliberate divergence

`pass-would-end-game` is excluded from the tight set and asserted on its own.
When a pass by the side to move would end the game, KataGo's `NNInputs` sets
`maxTurnsOfHistoryToInclude = 0` and suppresses the `passWouldEndPhase` global,
so the engine evaluates with no history planes; KataGo's Python `Features` has
no equivalent.

It is not a katascope bug and no config turns it off — it survives
`enablePassingHacks = false`, `conservativePass = false`, and a change of
ruleset. Passes themselves are fine: `with-passes` carries a pass in its history
and agrees exactly. The test bounds the divergence in both directions, so it
fails if it grows *or* if upstream aligns the encoders and it disappears.

### `ignorePreRootHistory`: the setting that made all of this look unfixable

Worth recording, because the wrong conclusion was very convincing.

Before this setting was found, every position with move history disagreed
(policy up to 0.147) while every history-free position agreed exactly. The
evidence fitted a story — "KataGo's C++ and Python feature code disagree about
the history planes, and katascope cannot fix that from outside" — and the golden
test was built in two tiers around it, with a 0.2 tolerance on the loose tier.

The real cause: the analysis engine defaults `ignorePreRootHistory` to **true**
(`Setup::DEFAULT_ANALYSIS_IGNORE_PRE_ROOT_HISTORY`), and at the root that sets
`maxHistory = 0`. The engine was reporting policy and ownership computed with no
history at all, however many moves the query supplied. Comparing that against a
forward pass that does encode history produces exactly the observed pattern.

The lesson is narrow and practical: a tolerance wide enough to accommodate a
mystery is a tolerance that hides one. When the evidence says "unfixable",
enumerate what the *reference* is doing differently before believing it.

### Three bugs this test caught

Worth recording, because each was invisible without it:

1. **Chinese rules sent with `multiStoneSuicideLegal: True`.** It is `False`.
   Rules occupy global input features, so the net saw a different position.
2. **The side to move inferred rather than stated.** With handicap stones and no
   moves, the service assumed Black and the engine inferred White. Ownership
   came back at correlation **-0.90** — perfectly, silently backwards. Both ends
   now send `initialPlayer` explicitly.
3. **KataGo's implicit handicap komi.** Chinese rules carry
   `whiteHandicapBonus = N`, adding the handicap stone count to White's komi —
   4 points on the handicap fixture. Both ends now pin it to 0 so the komi on
   the wire is the komi the network sees.

Two more were found in the engine config rather than the code, and both are now
pinned in `configs/analysis-deterministic.cfg`:

4. **`policyOptimism` defaults to 1.0 for analysis**, blending the reported
   policy toward the net's optimistic head.
5. **`ignorePreRootHistory` defaults to true for analysis**, discarding move
   history at the root — see below.

## `test_shapes.py`

Cheaper, and catches a different class of bug: the right numbers in the wrong
arrangement. The TypeScript side slices channels by arithmetic
(`data[c * area : (c + 1) * area]`), so a layout disagreement surfaces as a
heatmap of the wrong channel rather than as an error.

It asserts that the block and channel counts read *from the model* match the
emitted frames, that a frame is `(channels, height, width)` so a C-order flatten
gives the wire layout, that every block is addressable, that out-of-range blocks
raise, and that frames follow the position's board size rather than a default.

## Positions

`fixtures/positions.json`. Six, each chosen for a specific failure mode — the
`why` field on each entry says which. Non-square and 9×9 boards are in there
because a square 19×19 board cannot reveal an x/y swap.

## Why the checkpoint, not the `.bin.gz`

KataGo exports `.bin.gz` from the **SWA** (averaged) weights, so loading the raw
model from a checkpoint is not what the C++ engine runs — it costs about 2.5x
the disagreement. `ActivationExtractor` uses the SWA weights for that reason.
