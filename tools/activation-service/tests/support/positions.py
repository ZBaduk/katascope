"""Loads the golden-test positions.

Module-level rather than a fixture because ``pytest.mark.parametrize`` needs the
list at collection time, and having two sources for it would be one too many.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"


@dataclass(frozen=True)
class GoldenPosition:
    """One position, in the same encoding katascope puts on the wire."""

    name: str
    why: str
    board_x_size: int
    board_y_size: int
    rules: str
    komi: float
    initial_stones: list[tuple[str, str]]
    moves: list[tuple[str, str]]
    initial_player: str

    @property
    def area(self) -> int:
        return self.board_x_size * self.board_y_size

    def to_wire(self) -> dict:
        """The position in the protocol's own encoding, as the service takes it."""
        return {
            "boardXSize": self.board_x_size,
            "boardYSize": self.board_y_size,
            "rules": self.rules,
            "komi": self.komi,
            "initialStones": [list(s) for s in self.initial_stones],
            "moves": [list(m) for m in self.moves],
            "initialPlayer": self.initial_player,
        }


def load_positions() -> list[GoldenPosition]:
    loaded = json.loads((FIXTURES / "positions.json").read_text(encoding="utf-8"))
    return [
        GoldenPosition(
            name=str(entry["name"]),
            why=str(entry.get("why", "")),
            board_x_size=int(entry["boardXSize"]),
            board_y_size=int(entry["boardYSize"]),
            rules=str(entry.get("rules", "chinese")),
            komi=float(entry.get("komi", 7.5)),
            initial_stones=[(c, v) for c, v in entry.get("initialStones", [])],
            moves=[(c, v) for c, v in entry.get("moves", [])],
            initial_player=str(entry.get("initialPlayer", "B")),
        )
        for entry in loaded["positions"]
    ]


POSITIONS = load_positions()
