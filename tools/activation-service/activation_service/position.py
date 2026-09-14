"""Turns a wire position into a KataGo ``GameState``.

The service is stateless: every request carries its whole position, and this
module is the only thing that interprets it.

Two details that are easy to get wrong and impossible to notice afterwards:

* **Setup stones are not moves.** SGF ``AB``/``AW`` -- which is how handicap is
  recorded -- place stones without any of them being the previous move. The
  network sees recent play through history planes, so replaying handicap stones
  as moves would populate those planes with five imaginary moves.
* **GTP coordinates skip the letter I**, and their row numbers count up from the
  bottom while KataGo's ``Board`` indexes rows from the top.
"""

from __future__ import annotations

from typing import Any, Dict, Sequence, Tuple

from .vendored import Board, GameState
from .rules import rules_for

GTP_COLUMNS = "ABCDEFGHJKLMNOPQRSTUVWXYZ"

_PLAYERS = {"B": Board.BLACK, "W": Board.WHITE}


class BadPositionError(ValueError):
    """The request does not describe a position that can be built."""


def parse_player(text: str) -> int:
    player = _PLAYERS.get(text.strip().upper())
    if player is None:
        raise BadPositionError(f"expected player 'B' or 'W', got {text!r}")
    return player


def gtp_to_loc(board: Board, text: str) -> int:
    """GTP coordinate to a board location. ``pass`` maps to ``PASS_LOC``."""
    cleaned = text.strip().upper()
    if cleaned in ("PASS", ""):
        return Board.PASS_LOC
    column = GTP_COLUMNS.find(cleaned[:1])
    if column < 0:
        raise BadPositionError(f"bad GTP column in {text!r}")
    try:
        row = int(cleaned[1:])
    except ValueError as exc:
        raise BadPositionError(f"bad GTP row in {text!r}") from exc
    x = column
    # GTP rows count from the bottom; Board rows count from the top.
    y = board.y_size - row
    if not (0 <= x < board.x_size and 0 <= y < board.y_size):
        raise BadPositionError(f"{text!r} is off a {board.x_size}x{board.y_size} board")
    return board.loc(x, y)


def position_key(position: Dict[str, Any]) -> str:
    """A stable key for the forward-pass memo: the position's own content."""
    import json

    return json.dumps(position, sort_keys=True, separators=(",", ":"))


def build_game_state(position: Dict[str, Any]) -> GameState:
    """Builds the ``GameState`` a wire position describes."""
    try:
        x_size = int(position["boardXSize"])
        y_size = int(position["boardYSize"])
    except (KeyError, TypeError, ValueError) as exc:
        raise BadPositionError("position needs integer boardXSize and boardYSize") from exc
    if not (1 <= x_size <= 19 and 1 <= y_size <= 19):
        raise BadPositionError(f"unsupported board size {x_size}x{y_size}")

    rules = rules_for(str(position.get("rules", "chinese")), float(position.get("komi", 7.5)))
    state = GameState((x_size, y_size), rules)

    _place_setup_stones(state, position.get("initialStones", []))

    # Who moves first is explicit on the wire. Inferring it is how the handicap
    # fixture came out sign-flipped: all-Black setup stones mean White answers,
    # which an empty move list does not reveal.
    initial = str(position.get("initialPlayer", "B"))
    state.board.set_pla(parse_player(initial))

    _play_moves(state, position.get("moves", []))
    return state


def _place_setup_stones(state: GameState, stones: Sequence[Sequence[str]]) -> None:
    """Places stones directly, leaving the move history empty.

    ``set_stone`` rather than ``play``: setup stones have no move semantics, may
    be placed in any order, and must not capture or trigger ko.
    """
    if not stones:
        return
    for entry in stones:
        player, coordinate = _pair(entry, "initialStones")
        loc = gtp_to_loc(state.board, coordinate)
        if loc == Board.PASS_LOC:
            raise BadPositionError("a setup stone cannot be a pass")
        state.board.set_stone(parse_player(player), loc)

    # Rebase the history so the position with stones placed is the start.
    state.boards = [state.board.copy()]
    state.moves = []
    # The caller sets the side to move; setup stones do not decide it.


def _play_moves(state: GameState, moves: Sequence[Sequence[str]]) -> None:
    for index, entry in enumerate(moves):
        player, coordinate = _pair(entry, "moves")
        pla = parse_player(player)
        loc = gtp_to_loc(state.board, coordinate)
        # The mover is explicit in every entry, so colours need not alternate --
        # they do not, after a handicap.
        state.board.set_pla(pla)
        try:
            state.play(pla, loc)
        except Exception as exc:
            raise BadPositionError(f"move {index} ({player} {coordinate}) is illegal: {exc}") from exc


def _pair(entry: Sequence[str], field: str) -> Tuple[str, str]:
    if not isinstance(entry, (list, tuple)) or len(entry) != 2:
        raise BadPositionError(f"{field} entries must be [player, coordinate] pairs, got {entry!r}")
    return str(entry[0]), str(entry[1])
