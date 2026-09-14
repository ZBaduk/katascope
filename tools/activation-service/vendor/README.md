# vendored KataGo

A copy of `python/katago` from [KataGo](https://github.com/lightvector/KataGo)
**v1.17.1**, MIT licensed — see `KATAGO_LICENSE`.

## Why vendored

KataGo publishes no package for its training code, and the activation service
needs three things from it that must not be reimplemented:

- `katago.game.features.Features` — the **input feature encoding**. Intricate
  (ladder detection, area and pass-alive scoring, history planes, a dozen rules
  globals) and unforgiving: an independent version would be wrong in ways only
  the golden test can see, and only after someone had trusted the output.
- `katago.train.model_pytorch` — the model, including the `ExtraOutputs`
  instrumentation that already reports `trunk_after_block{i}`. That is where
  katascope's activations come from; there are no forward hooks.
- `katago.train.load_model` — checkpoint loading, including the SWA weights.

## Rules

- **Do not edit these files.** If something needs changing, upstream it or wrap
  it from `activation_service/`. A local patch here is invisible to everyone
  reading upstream's code and will be lost at the next update.
- Import through `activation_service.vendored`, which is the single place the
  `sys.path` entry is added.
- To update: copy `python/katago` from the new tag, re-run
  `measure_agreement.py`, and update the golden tolerances if they moved.

## Agreement with the C++ engine

`Features` matches the C++ `NNInputs` to float32 rounding (~1e-6 on policy and
ownership) for every fixture position, move history included.

An earlier version of this file claimed otherwise — that the two encoders
disagreed once a position had history, and that it was unfixable. That was
wrong. The engine was evaluating the root with `ignorePreRootHistory`, which the
analysis engine defaults to **true** and which sets `maxHistory = 0`, so it was
reporting numbers computed with no history at all. The Python side was correct
throughout. `configs/analysis-deterministic.cfg` now sets it to false.

One narrow divergence remains, and it is deliberate on KataGo's part: when a
pass by the side to move would end the game, `NNInputs` sets
`maxTurnsOfHistoryToInclude = 0` and suppresses the `passWouldEndPhase` global,
hiding the history from the net. `Features` has no equivalent. It is confined to
that case — a pass anywhere else in the history encodes identically — and is
covered by `test_katago_hides_history_when_a_pass_would_end_the_game`.
