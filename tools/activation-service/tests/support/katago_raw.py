"""Reads raw-net output from a real ``katago`` binary.

This is the oracle the golden test measures the Python model against, so it is
real code even though the thing it will judge is still a stub.

``katago analysis`` with ``maxVisits: 1`` plus ``includePolicy`` and
``includeOwnership`` gives the network's own policy and ownership for the root
position with essentially no search on top. That is close enough to a raw-net
forward pass to catch what the golden test exists to catch: a transposed board,
an off-by-one in the history planes, the wrong side to move, a flipped ownership
sign.
"""

from __future__ import annotations

import json
import subprocess
from dataclasses import dataclass
from typing import Any, Iterator

import numpy as np


@dataclass(frozen=True)
class RawNetResult:
    """Policy and ownership for one position, straight from the network."""

    policy: np.ndarray
    """``board_x_size * board_y_size + 1`` probabilities; last element is pass.

    KataGo reports -1 for illegal moves; those are left as -1, not zeroed, so a
    caller has to decide what to do about them rather than silently comparing
    against a fabricated zero.
    """

    ownership: np.ndarray
    """``board_y_size * board_x_size``, row-major, in [-1, 1] from Black's view."""

    winrate: float
    score_lead: float


class KatagoRawNet:
    """A ``katago analysis`` process used only for raw-net queries.

    Starting KataGo is slow (model load, sometimes a cuDNN autotune), so the
    process is reused across positions and the whole thing is a context manager.
    """

    def __init__(self, katago_path: str, model_path: str, config_path: str) -> None:
        self._argv = [
            katago_path,
            "analysis",
            "-model",
            model_path,
            "-config",
            config_path,
        ]
        self._process: subprocess.Popen[str] | None = None
        self._next_id = 0

    def __enter__(self) -> "KatagoRawNet":
        self._process = subprocess.Popen(
            self._argv,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            bufsize=1,
        )
        return self

    def __exit__(self, *_exc: object) -> None:
        process = self._process
        if process is None:
            return
        try:
            if process.stdin is not None:
                process.stdin.close()
            process.wait(timeout=10)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
        finally:
            self._process = None

    def query(
        self,
        *,
        board_x_size: int,
        board_y_size: int,
        moves: list[tuple[str, str]],
        initial_stones: list[tuple[str, str]] | None = None,
        rules: str = "chinese",
        komi: float = 7.5,
        initial_player: str = "B",
    ) -> RawNetResult:
        """Evaluates the position after ``moves`` with a single visit."""
        process = self._require_process()
        self._next_id += 1
        query_id = f"raw-{self._next_id}"
        query: dict[str, Any] = {
            "id": query_id,
            "boardXSize": board_x_size,
            "boardYSize": board_y_size,
            "rules": rules,
            "komi": komi,
            "initialStones": initial_stones or [],
            "moves": moves,
            "initialPlayer": initial_player,
            # The komi on the wire must be exactly the komi the network sees.
            # Chinese rules carry whiteHandicapBonus=N, which silently adds the
            # handicap stone count to White's komi -- worth 4 points on the
            # handicap fixture, and enough to move the policy by 8e-3.
            "whiteHandicapBonus": "0",
            "analyzeTurns": [len(moves)],
            "maxVisits": 1,
            "includePolicy": True,
            "includeOwnership": True,
        }

        assert process.stdin is not None
        process.stdin.write(json.dumps(query) + "\n")
        process.stdin.flush()

        response = self._read_response(query_id)
        if "error" in response:
            raise RuntimeError(f"katago rejected the query: {response['error']}")

        area = board_x_size * board_y_size
        policy = np.asarray(response["policy"], dtype=np.float64)
        ownership = np.asarray(response["ownership"], dtype=np.float64)
        if policy.shape != (area + 1,):
            raise AssertionError(f"policy has shape {policy.shape}, expected {(area + 1,)}")
        if ownership.shape != (area,):
            raise AssertionError(f"ownership has shape {ownership.shape}, expected {(area,)}")

        root = response.get("rootInfo", {})
        return RawNetResult(
            policy=policy,
            ownership=ownership,
            winrate=float(root.get("winrate", float("nan"))),
            score_lead=float(root.get("scoreLead", float("nan"))),
        )

    def _require_process(self) -> subprocess.Popen[str]:
        if self._process is None:
            raise RuntimeError("KatagoRawNet must be used as a context manager")
        return self._process

    def _read_response(self, query_id: str) -> dict[str, Any]:
        """Returns the first response carrying ``query_id``, skipping chatter."""
        for line in self._stdout_lines():
            try:
                parsed = json.loads(line)
            except json.JSONDecodeError:
                continue  # Banner text on stdout; KataGo does this.
            if isinstance(parsed, dict) and parsed.get("id") == query_id:
                return parsed
        raise RuntimeError(f"katago exited before answering {query_id}: {self._stderr_tail()}")

    def _stdout_lines(self) -> Iterator[str]:
        process = self._require_process()
        assert process.stdout is not None
        for line in process.stdout:
            if line.strip():
                yield line

    def _stderr_tail(self, limit: int = 40) -> str:
        process = self._require_process()
        if process.stderr is None:
            return ""
        return "\n".join(process.stderr.read().splitlines()[-limit:])


def policy_to_grid(policy: np.ndarray, board_x_size: int, board_y_size: int) -> np.ndarray:
    """Reshapes the board part of a policy vector, dropping the pass element."""
    return policy[:-1].reshape(board_y_size, board_x_size)
