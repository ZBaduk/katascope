# core fixtures

Test data for `@katascope/core`. Everything here is checked in, small, and
readable — a fixture you cannot read in a diff is a fixture you cannot trust.

Load them with the helper in `test/support/fixtures.ts`, never with a hand-built
relative path.

## `sgf/`

| File | Covers |
|---|---|
| `simple-game.sgf` | The ordinary case: full root info (`PB`/`PW`/`BR`/`WR`/`EV`/`DT`/`RE`), 18 plain moves, no setup. |
| `handicap-4.sgf` | `HA[4]` with the four handicap stones as `AB`, `KM[0.5]`, White to play first. |
| `setup-ab-aw.sgf` | `AB`/`AW` setup with a **compressed rectangle** (`AW[bb:bd]`), escaped brackets in a `C` comment, and an `AE` property. |
| `passes-and-resign.sgf` | Both pass encodings — `B[]` (FF[4]) and `W[tt]` (the FF[3] convention) — on a 9×9 board, with `RE[W+Resign]`. |
| `variations.sgf` | Two variations branching after move 2. The main line is the first child; variations are parsed but not retained in the `GameRecord`. |
| `rectangular-13x9.sgf` | `SZ[13:9]`. KataGo supports non-square boards, so nothing may assume width equals height. |
| `malformed-unterminated.sgf` | Truncated mid-property. Must raise `SgfParseError`, not hang or return junk. |

### Known gap: `AE`

`setup-ab-aw.sgf` contains an `AE` (add-empty) property. The parser **ignores
it**. `test/sgf-parser.spec.ts` asserts that current behaviour explicitly, so
the day someone implements `AE` the test fails and tells them to update the
expectation rather than silently changing what the fixture means.

## `kact/`

| File | Covers |
|---|---|
| `tiny-b2c3.kact` | A structurally complete capture at doll's-house scale: 2 blocks, 3 channels, 5×5 board, 3 move numbers, 6 frames, 1,270 bytes. Values come from `FakeActivationStore` with seed 20260914, so it is reproducible and obviously synthetic. |

The fixture exists because an encoder and decoder that agree with each other but
not with the format on disk is exactly what a same-process round trip cannot
catch. `kact-codec.spec.ts` reads this file, decodes every frame, and re-encodes
it to **the same bytes** — so a change to field order, padding, or the index
entry size fails even when encode and decode still agree with one another.

Regenerate it only deliberately, and when you do, say why in the commit: the
byte-for-byte assertion is the point.

## `heads/`

| File | What it is |
| --- | --- |
| `tiny-head.json` | Both output heads at doll's-house scale: 6 trunk channels, 4 head channels, a 5x4 board inside a 5x5 extent. Weights, a trunk frame, the expected head input, policy logits, pass logit, softmax, ownership map, and one reduction. |

**Generated, not hand-written.** `tools/activation-service/tools/make_head_fixture.py`
writes it from the numpy reference implementation that `test_head_golden.py`
pins to the real model, so the TypeScript head is checked against numbers that
came from KataGo rather than from itself. Regenerate rather than edit:

```
cd tools/activation-service && .venv/bin/python tools/make_head_fixture.py
```

The board is deliberately rectangular *inside* a larger extent, because that is
the case where a forgotten mask still looks correct: on a square game filling
the network the mask is all ones and every masking bug disappears.
