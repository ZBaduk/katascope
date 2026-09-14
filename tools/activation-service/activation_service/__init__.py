"""katascope activation service.

Loads a KataGo model, runs positions through it, and serves per-(move, block)
activation frames to the Electron app over newline-delimited JSON on stdio.

The wire protocol is specified in
``packages/katago-bridge/src/activations/sidecar-protocol.ts``, which is the
single source of truth for both ends.

Model internals come from KataGo's own ``model_pytorch`` code, vendored under
``vendor/``. The input feature encoding is KataGo's too -- reimplementing it
would be wrong in ways only the golden test could find. See ``tests/README.md``.
"""

__version__ = "0.1.0"

# Gate for the tests that need a loaded model. True since load_model became
# real; the model- and katago-gated skips in conftest still apply.
IMPLEMENTED = True
