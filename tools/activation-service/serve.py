#!/usr/bin/env python3
"""katascope activation service.

Reads requests as newline-delimited JSON on stdin and writes responses on
stdout, where a response carrying bulk float data is a JSON header line
followed immediately by that many raw bytes. The protocol is specified in
``packages/katago-bridge/src/activations/sidecar-protocol.ts``, which is the
single source of truth for both sides.

Minimal and stateless by design: no session, no loaded-game concept, no move
numbering. Every request carries the position it is about, so the two sides
cannot disagree about what is loaded, and a crash loses nothing but a forward
pass.

Everything that is not a response -- progress, warnings, tracebacks -- goes to
stderr, which the bridge surfaces in the Diagnostics tab. Writing anything but
a response to stdout would desynchronise the stream.
"""

from __future__ import annotations

import argparse
import json
import sys
import traceback
from typing import Any, Dict, Optional

import numpy as np


def _log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


class Service:
    """Dispatches requests against a lazily loaded model."""

    def __init__(self, model_path: str, device: str, max_move_number: int) -> None:
        self._model_path = model_path
        self._device = device
        self._max_move_number = max_move_number
        self._extractor: Any = None

    def _load(self) -> Any:
        if self._extractor is None:
            from activation_service.model import load_model

            _log(f"activation-service: loading {self._model_path} on {self._device}")
            self._extractor = load_model(self._model_path, device=self._device)
            spec = self._extractor.spec
            _log(
                f"activation-service: loaded {spec.name} "
                f"b{spec.blocks}c{spec.channels} @ {spec.board_x_size}x{spec.board_y_size}"
            )
        return self._extractor

    def handle(self, request: Dict[str, Any]) -> None:
        kind = request.get("type")
        request_id = request.get("id")
        if kind == "describe":
            self._describe(request_id)
        elif kind == "frame":
            self._frame(request_id, request)
        elif kind == "heads":
            self._heads(request_id, request)
        elif kind == "head_weights":
            self._head_weights(request_id)
        elif kind == "reader_weights":
            self._reader_weights(request_id)
        elif kind == "attribute":
            self._attribute(request_id, request)
        else:
            _respond({"id": request_id, "ok": False, "error": f"unknown request type {kind!r}"})

    def _describe(self, request_id: Optional[str]) -> None:
        spec = self._load().spec
        _respond(
            {
                "id": request_id,
                "ok": True,
                "network": {
                    "name": spec.name,
                    "blocks": spec.blocks,
                    "channels": spec.channels,
                    "boardXSize": spec.board_x_size,
                    "boardYSize": spec.board_y_size,
                },
                "maxMoveNumber": self._max_move_number,
                "dtype": "float32",
            }
        )

    def _frame(self, request_id: Optional[str], request: Dict[str, Any]) -> None:
        extractor = self._load()
        position = request.get("position")
        if not isinstance(position, dict):
            raise ValueError("frame request needs a 'position' object")
        array = extractor.frame(position, int(request.get("block", -1)))

        # float32 little-endian, C-order: channel-major, row-major within a
        # channel, exactly what the TypeScript side slices by arithmetic.
        payload = np.ascontiguousarray(array, dtype="<f4").tobytes()
        _respond(
            {
                "id": request_id,
                "ok": True,
                "dtype": "float32",
                "min": float(array.min()) if array.size else 0.0,
                "max": float(array.max()) if array.size else 0.0,
                "binaryBytes": len(payload),
            },
            payload,
        )

    def _reader_weights(self, request_id: Optional[str]) -> None:
        weights = self._load().reader_weights()
        # One named C-float run per vector, in the order they are written.
        vectors = [f"block:{i}" for i in range(len(weights.by_block))]
        arrays = list(weights.by_block)
        for head in ("policy", "value"):
            vectors.append(f"head:{head}")
            arrays.append(weights.heads[head])

        payload = _float32_bytes(*arrays)
        _respond(
            {
                "id": request_id,
                "ok": True,
                "dtype": "float32",
                "channels": weights.channels,
                "vectors": vectors,
                "binaryBytes": len(payload),
            },
            payload,
        )

    def _head_weights(self, request_id: Optional[str]) -> None:
        """Both heads' parameters, as one binary run of named tensors.

        Named rather than positional because the set is version-dependent: the
        pass path gains two entries at model version 15, and a consumer that
        counted tensors instead of naming them would silently misread every
        later one.
        """
        weights = self._load().head_weights()
        names = list(weights.tensors.keys())
        arrays = [weights.tensors[name] for name in names]
        payload = _float32_bytes(*arrays)
        _respond(
            {
                "id": request_id,
                "ok": True,
                "dtype": "float32",
                "version": weights.version,
                "activation": weights.activation,
                "trunkChannels": weights.trunk_channels,
                "posLen": weights.pos_len,
                "trunkFinalScale": weights.trunk_final_scale,
                "tensors": [
                    {"name": name, "shape": list(weights.shapes[name])} for name in names
                ],
                "binaryBytes": len(payload),
            },
            payload,
        )

    def _attribute(self, request_id: Optional[str], request: Dict[str, Any]) -> None:
        extractor = self._load()
        position = request.get("position")
        if not isinstance(position, dict):
            raise ValueError("attribute request needs a 'position' object")
        target = request.get("target")
        if not isinstance(target, dict):
            raise ValueError("attribute request needs a 'target' object")

        raw_block = request.get("planeBlock")
        plane_block = None if raw_block is None else int(raw_block)
        result = extractor.attribute(position, target, plane_block=plane_block)

        spec = extractor.spec
        payload = _float32_bytes(result.by_block, result.planes)
        header: Dict[str, Any] = {
            "id": request_id,
            "ok": True,
            "dtype": "float32",
            "blocks": spec.blocks,
            "channels": spec.channels,
            "binaryBytes": len(payload),
        }
        if result.planes is not None:
            header["planeBlock"] = result.plane_block
            header["planeShape"] = list(result.planes.shape)
        _respond(header, payload)

    def _heads(self, request_id: Optional[str], request: Dict[str, Any]) -> None:
        extractor = self._load()
        position = request.get("position")
        if not isinstance(position, dict):
            raise ValueError("heads request needs a 'position' object")
        heads = extractor.raw_heads(position)
        _respond(
            {
                "id": request_id,
                "ok": True,
                "policy": [float(v) for v in heads.policy],
                "ownership": [float(v) for v in heads.ownership],
                "value": [float(v) for v in heads.value],
                "scoreLead": heads.score_lead,
            }
        )


def _float32_bytes(*arrays) -> bytes:
    """Concatenates arrays as little-endian float32, C-order."""
    parts = [np.ascontiguousarray(a, dtype="<f4").tobytes() for a in arrays if a is not None]
    return b"".join(parts)


def _respond(header: Dict[str, Any], payload: bytes = b"") -> None:
    """Writes one response: a JSON line, then its payload, then flush.

    Both go to the raw buffer so the header's newline and the payload cannot be
    reordered or separated by Python's text-layer buffering.
    """
    out = sys.stdout.buffer
    out.write(json.dumps(header, separators=(",", ":")).encode("utf-8"))
    out.write(b"\n")
    if payload:
        out.write(payload)
    out.flush()


def main(argv: Optional[list] = None) -> int:
    parser = argparse.ArgumentParser(description="katascope activation service")
    parser.add_argument("--model", required=True, help="path to a KataGo .ckpt checkpoint")
    parser.add_argument("--device", default="cpu", help="torch device (cpu, mps, cuda)")
    parser.add_argument(
        "--max-move-number",
        type=int,
        default=1000,
        help="highest move number the service will claim to serve",
    )
    args = parser.parse_args(argv)

    service = Service(args.model, args.device, args.max_move_number)
    _log("activation-service: ready")

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            request = json.loads(line)
        except json.JSONDecodeError as exc:
            _respond({"ok": False, "error": f"malformed request: {exc}"})
            continue
        if not isinstance(request, dict):
            _respond({"ok": False, "error": "request must be a JSON object"})
            continue

        try:
            service.handle(request)
        except Exception as exc:  # noqa: BLE001 - one bad request must not end the process
            # The traceback goes to the log; the caller gets the message. A
            # service that dies on a malformed request takes the app's
            # activation panel with it.
            _log(traceback.format_exc())
            _respond({"id": request.get("id"), "ok": False, "error": f"{type(exc).__name__}: {exc}"})

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
