"""KataGo ruleset names to the rules dict the feature encoder reads.

These must match ``Rules::parseRules`` in ``cpp/game/rules.cpp`` exactly. They
are part of the network's *input*: ko rule, scoring rule, tax rule, suicide
legality and komi all occupy global input features, so getting one wrong feeds
the model a different position than KataGo fed it and every activation derived
from it is wrong in a way nothing downstream can see.

That is not hypothetical. During development, passing ``multiStoneSuicideLegal:
True`` for Chinese rules (it is False) shifted the policy by enough to notice
but not enough to look broken.
"""

from __future__ import annotations

from typing import Any, Dict

# Keys consumed by katago.game.features.Features.fill_row_features.
_BASE: Dict[str, Any] = {
    "encorePhase": 0,
    "passWouldEndPhase": False,
    "asymPowersOfTwo": 0.0,
}

_RULESETS: Dict[str, Dict[str, Any]] = {
    "chinese": {
        "koRule": "KO_SIMPLE",
        "scoringRule": "SCORING_AREA",
        "taxRule": "TAX_NONE",
        "multiStoneSuicideLegal": False,
        "hasButton": False,
    },
    "japanese": {
        "koRule": "KO_SIMPLE",
        "scoringRule": "SCORING_TERRITORY",
        "taxRule": "TAX_SEKI",
        "multiStoneSuicideLegal": False,
        "hasButton": False,
    },
    "tromp-taylor": {
        "koRule": "KO_POSITIONAL",
        "scoringRule": "SCORING_AREA",
        "taxRule": "TAX_NONE",
        "multiStoneSuicideLegal": True,
        "hasButton": False,
    },
    "aga": {
        "koRule": "KO_SITUATIONAL",
        "scoringRule": "SCORING_AREA",
        "taxRule": "TAX_NONE",
        "multiStoneSuicideLegal": False,
        "hasButton": False,
    },
    "new-zealand": {
        "koRule": "KO_SITUATIONAL",
        "scoringRule": "SCORING_AREA",
        "taxRule": "TAX_NONE",
        "multiStoneSuicideLegal": True,
        "hasButton": False,
    },
}

# Spellings KataGo accepts for the same ruleset.
_ALIASES = {
    "chinese-ogs": "chinese",
    "chineseogs": "chinese",
    "chinese_ogs": "chinese",
    "tromp_taylor": "tromp-taylor",
    "tromptaylor": "tromp-taylor",
    "newzealand": "new-zealand",
    "new_zealand": "new-zealand",
}


class UnknownRulesError(ValueError):
    """Raised rather than guessing. A wrong ruleset is silently wrong."""


def rules_for(name: str, komi: float) -> Dict[str, Any]:
    """Builds the rules dict for a ruleset name and komi.

    Raises ``UnknownRulesError`` for anything not listed. Falling back to a
    default would produce activations for a position nobody asked about.
    """
    key = name.strip().lower().replace(" ", "")
    key = _ALIASES.get(key, key)
    preset = _RULESETS.get(key)
    if preset is None:
        known = ", ".join(sorted(_RULESETS))
        raise UnknownRulesError(f"unsupported ruleset {name!r}; known: {known}")
    rules = dict(_BASE)
    rules.update(preset)
    rules["whiteKomi"] = float(komi)
    return rules


def known_rulesets() -> list[str]:
    return sorted(_RULESETS)
