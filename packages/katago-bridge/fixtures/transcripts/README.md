# process transcripts

Recorded stdin/stdout exchanges for the two processes the bridge spawns. A test
points `katagoPath` or `pythonPath` at a shim that replays one of these, so the
bridge does real spawning, real pipes, and real exit codes against a fake peer.

See `test/support/scripted-process.mjs` for the transcript grammar, and
`scripted-process.ts` for the shim helper.

| Transcript | Drives |
|---|---|
| `katago-version.json` | `query_version` happy path, with realistic startup chatter on stderr. |
| `katago-analysis.json` | A full analysis query. `expect` asserts the exact wire encoding — board size, rules, komi, GTP move pairs, `analyzeTurns`. |
| `katago-query-error.json` | An `{"error": ..., "field": ...}` rejection. |
| `katago-noisy-stdout.json` | Non-JSON banner lines on **stdout**, which the reader must skip rather than choke on. |
| `katago-crash.json` | The engine dying mid-request with stderr worth reporting. |
| `katago-silent.json` | A request that is never answered, for the timeout path. |
| `sidecar-describe-frame.json` | `describe` then `frame` for a 2-block, 2-channel, 2×2 toy net. The 8 floats are `[0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5]`. |
| `sidecar-heads.json` | The `heads` request the golden test depends on. |
| `sidecar-frame-error.json` | `{"ok": false, "error": ...}` for an out-of-range block. |
| `sidecar-short-frame.json` | A payload too small for the declared network shape. |
| `sidecar-bad-describe.json` | A `describe` reply missing `network` entirely. |
| `sidecar-no-payload.json` | A frame reply that forgets its binary payload. |

Sidecar frames are **binary**: a JSON header line, then raw little-endian
float32 bytes. A transcript writes `"binaryFloat32": [...]` and the harness
encodes the payload and fills in `binaryBytes`. Payloads are deliberately tiny —
a 2×2 board and 2 channels — so a transcript stays readable.
