"""
Codiv System One (OpenJEV / Laya) — NAVIGATOR brain for Dr. Drive.

Jev is asked only real, legal, still-needed choices. The 60 Hz executor owns
steering, stop-line physics, pedestrian yield, and committed turns.

Trust modes (JEV_TRUST / request.trust):
  strict_confidence — drop answers below solid confidence thresholds
  soft_confidence   — lower bar; still drop pure guesses
  follow_jev        — always apply Jev's legal choice (ignore confidence)
  planner_only      — never call Codiv; local Dijkstra / rules only
"""

from __future__ import annotations

import json
import os
import threading
import time
from typing import Any

import requests

from local_fallback import decide_local

TRUST_MODES = ("strict_confidence", "soft_confidence", "follow_jev", "planner_only")
AWAY_SLACK_M = 40


def _goal_name(state: dict[str, Any] | None = None) -> str:
    g = (state or {}).get("goal") or {}
    return str(g.get("name") or "the destination area")

# Per-mode confidence floors (0 = accept any reported confidence)
TRUST_THRESHOLDS: dict[str, dict[str, float]] = {
    "strict_confidence": {"turn": 0.62, "pace": 0.55, "gear": 0.50, "block": 0.58},
    "soft_confidence": {"turn": 0.35, "pace": 0.30, "gear": 0.25, "block": 0.30},
    "follow_jev": {"turn": 0.0, "pace": 0.0, "gear": 0.0, "block": 0.0},
    "planner_only": {"turn": 1.0, "pace": 1.0, "gear": 1.0, "block": 1.0},
}


def _normalize_trust(raw: Any) -> str:
    s = str(raw or "").strip().lower().replace("-", "_").replace(" ", "_")
    aliases = {
        "strict": "strict_confidence",
        "confidence": "strict_confidence",
        "soft": "soft_confidence",
        "follow": "follow_jev",
        "jev": "follow_jev",
        "always": "follow_jev",
        "planner": "planner_only",
        "local": "planner_only",
        "none": "planner_only",
    }
    s = aliases.get(s, s)
    return s if s in TRUST_MODES else "strict_confidence"


def resolve_trust(state: dict[str, Any] | None = None) -> str:
    st = state or {}
    if st.get("trust"):
        return _normalize_trust(st.get("trust"))
    return _normalize_trust(os.getenv("JEV_TRUST", "strict_confidence"))


def trust_thresholds(mode: str) -> dict[str, float]:
    return TRUST_THRESHOLDS.get(_normalize_trust(mode), TRUST_THRESHOLDS["strict_confidence"])

SPEED_OPTS = {
    "fast": "Open road: no lead within ~55 m, next move is straight, GREEN with time to spare — gears 4/5 (~90 km/h)",
    "go": "Normal city pace (~45 km/h)",
    "crawl": "Slow crawl — congested box, tight gap, or busy zebra nearby",
}
GEAR_OPTS = {
    "1": "1st — 0–~32 km/h, every pull-away",
    "2": "2nd — ~15–54 km/h",
    "3": "3rd — ~32–79 km/h",
    "4": "4th — ~55–105 km/h",
    "5": "5th — open road above ~75 km/h",
}
BLOCKED_OPTS = {
    "wait": "Stay behind the lead (just stopped, or alt lane not clear)",
    "horn": "Horn — lead is stationary on our GREEN/none",
    "change_lane": "Pass in the other lane — only if that lane is clear",
}

VALID_TURNS = ("left", "right", "straight")
ASK_KEYS = ("next_turn", "turn_after_next", "speed_mode", "gear", "blocked_action")


def _choice(instructions: str, criteria: dict[str, str]) -> dict[str, Any]:
    return {"type": "choice", "instructions": instructions.strip(), "criteria": criteria}


def _norm_turn(raw: Any, allow_park: bool = False) -> str | None:
    s = str(raw or "").strip().lower()
    if s in VALID_TURNS:
        return s
    if allow_park and "park" in s:
        return "park"
    if "left" in s:
        return "left"
    if "right" in s:
        return "right"
    if "straight" in s or "ahead" in s:
        return "straight"
    return None


def _trim_surround(surround: dict[str, Any] | None) -> dict[str, Any]:
    if not surround:
        return {}
    out: dict[str, Any] = {}
    for k, v in surround.items():
        if isinstance(v, list) and v:
            out[k] = [
                {kk: vv for kk, vv in o.items() if kk in ("kind", "dist_m", "along_m", "lat_m", "closing_kmh", "turning", "in_box", "oncoming")}
                for o in v[:2]
            ]
    return out


def _ask_flags(state: dict[str, Any]) -> dict[str, bool]:
    raw = state.get("ask")
    if isinstance(raw, dict) and raw:
        return {k: bool(raw.get(k)) for k in ASK_KEYS}
    return {k: True for k in ASK_KEYS}


def _can_map(j: dict[str, Any]) -> dict[str, bool]:
    return {
        "can_left": bool(j.get("can_left")),
        "can_right": bool(j.get("can_right")),
        "can_straight": bool(j.get("can_straight")),
    }


def _recommended_turn(can: dict[str, Any], costs: dict[str, Any]) -> tuple[str | None, float]:
    best: str | None = None
    best_c = 1e12
    for t in VALID_TURNS:
        if not can.get(f"can_{t}"):
            continue
        c = costs.get(t)
        if isinstance(c, (int, float)) and c < best_c:
            best, best_c = t, float(c)
        elif best is None:
            best = t
    return best, best_c


def _shortest_exit_blocked(state: dict[str, Any], recommended: str | None) -> bool:
    if not recommended:
        return False
    lead = state.get("lead") or {}
    if recommended == "straight" and lead.get("blocking"):
        return True
    return False


def _turn_is_away(
    turn: str,
    cost: Any,
    rec: str | None,
    rec_c: float,
    goal: dict[str, Any],
) -> bool:
    """True when this arm goes the wrong way vs the destination area."""
    if rec and turn == rec:
        return False
    try:
        bearing = abs(float(goal.get("bearing_deg") or 0))
    except (TypeError, ValueError):
        bearing = 0.0
    if bearing > 100 and turn == "straight" and rec and rec != "straight":
        return True
    if isinstance(cost, (int, float)) and rec_c < 1e11 and cost > rec_c + AWAY_SLACK_M:
        return True
    dist = goal.get("dist_m")
    if isinstance(cost, (int, float)) and isinstance(dist, (int, float)) and cost > dist + 100:
        return True
    return False


def _legal_turn_criteria(can: dict[str, Any], costs: dict[str, Any], best: str | None, state: dict[str, Any] | None = None) -> dict[str, str]:
    rec, rec_c = _recommended_turn(can, costs)
    if rec and not best:
        best = rec
    goal = (state or {}).get("goal") or {}
    ranked: list[tuple[str, float | None]] = []
    for t in VALID_TURNS:
        if not can.get(f"can_{t}"):
            continue
        cost = costs.get(t)
        ranked.append((t, float(cost) if isinstance(cost, (int, float)) else None))
    ranked.sort(key=lambda row: row[1] if row[1] is not None else 1e12)

    # Only offer arms that still head toward P. Never let Jev pick an opposite/detour.
    out: dict[str, str] = {}
    for i, (t, cost) in enumerate(ranked):
        if _turn_is_away(t, cost, rec, rec_c, goal):
            continue
        remaining = f"{int(cost)} m remaining to {_goal_name(state)}" if cost is not None else "path length unknown"
        extra = int(cost - rec_c) if cost is not None and rec_c < 1e11 else 0
        rank = i + 1
        if i == 0 or t == best:
            out[t] = f"RANK {rank} TOWARD P. {t.upper()}. {remaining}. Pick this."
        else:
            out[t] = f"RANK {rank} still toward P. {t.upper()}. {remaining} (+{extra} m vs BEST)."
    if not out and ranked:
        t, cost = ranked[0]
        remaining = f"{int(cost)} m remaining to {_goal_name(state)}" if cost is not None else "path length unknown"
        out[t] = f"RANK 1 TOWARD P. {t.upper()}. {remaining}. Pick this."
    return out


def _legal_gears(speed_kmh: float, current: str) -> dict[str, str]:
    bands = {"1": (0, 36), "2": (12, 56), "3": (30, 82), "4": (52, 110), "5": (72, 999)}
    out: dict[str, str] = {}
    for g, (lo, hi) in bands.items():
        if lo <= speed_kmh <= hi:
            out[g] = GEAR_OPTS[g]
    if current in GEAR_OPTS:
        out[current] = GEAR_OPTS[current]
    if "1" not in out and speed_kmh < 12:
        out["1"] = GEAR_OPTS["1"]
    return out


def _pace_criteria(state: dict[str, Any]) -> dict[str, str]:
    if resolve_trust(state) == "follow_jev":
        return {
            "fast": SPEED_OPTS["fast"],
            "go": SPEED_OPTS["go"],
            "crawl": SPEED_OPTS["crawl"],
        }
    lead = state.get("lead") or {}
    nj = (state.get("route") or {}).get("next_junction") or {}
    sig = str((state.get("signal") or {}).get("color") or "NONE").upper()
    peds = state.get("pedestrians") or []
    lead_d = float(lead.get("dist_m") or 999) if lead else 999
    plan_turn = str(state.get("locked_turn") or ((state.get("route") or {}).get("plan") or {}).get("next_turn") or "straight")
    turning_soon = plan_turn != "straight" and float(nj.get("dist_stop_m") or 999) < 90
    ped_near = any(
        (p.get("crossing") or p.get("on_zebra")) and -2 < float(p.get("along_m") or 99) < 50
        for p in peds
    )
    light = nj.get("light") or {}
    green_ok = (not light) or (
        light.get("color") == "GREEN" and float(light.get("seconds") or 0) > float(nj.get("eta_s") or 0) + 2
    )
    out = {"go": SPEED_OPTS["go"]}
    congested = lead_d < 22 or bool((state.get("surround") or {}).get("in_box")) or ped_near
    if congested:
        out["crawl"] = SPEED_OPTS["crawl"]
    if lead_d > 55 and not turning_soon and not ped_near and plan_turn == "straight" and green_ok and sig not in ("RED", "YELLOW"):
        out["fast"] = SPEED_OPTS["fast"]
    return out


def _blocked_criteria(state: dict[str, Any]) -> dict[str, str]:
    lanes = state.get("lanes") or {}
    sig = str((state.get("signal") or {}).get("color") or "NONE").upper()
    nj = (state.get("route") or {}).get("next_junction") or {}
    plan = (state.get("route") or {}).get("plan") or {}
    turn = str(state.get("locked_turn") or plan.get("next_turn") or "straight")
    stop = float(nj.get("dist_stop_m") or 999)
    out = {"wait": BLOCKED_OPTS["wait"], "horn": BLOCKED_OPTS["horn"]}
    near_line_right = turn == "right" and -1 < stop < 30
    if lanes.get("change_allowed") and (lanes.get("alt") or {}).get("clear") and sig != "RED" and not near_line_right:
        out["change_lane"] = BLOCKED_OPTS["change_lane"]
    return out


def _turn_option_rows(can: dict[str, Any], costs: dict[str, Any], best: str | None) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for t in VALID_TURNS:
        legal = bool(can.get(f"can_{t}"))
        if not legal:
            continue
        cost = costs.get(t)
        rows.append({
            "turn": t,
            "remaining_m": int(cost) if isinstance(cost, (int, float)) else None,
            "shortest": t == best,
        })
    rows.sort(key=lambda r: r["remaining_m"] if isinstance(r.get("remaining_m"), int) else 10**9)
    return rows


def build_payload(state: dict[str, Any], model: str) -> dict[str, Any]:
    goal = state.get("goal") or {}
    ego = state.get("ego") or {}
    sig = state.get("signal") or {}
    route = state.get("route") or {}
    plan = route.get("plan") or {}
    nj = route.get("next_junction") or {}
    an = route.get("after_next") or {}
    predicted = state.get("predicted") or {}
    prev_d = state.get("previous_decision") or {}
    ask = _ask_flags(state)
    why = state.get("why") or []

    for_junction = state.get("for_junction") or nj.get("id")
    after_next = state.get("after_next") or an.get("id")
    costs = plan.get("costs") or {}
    best = plan.get("next_turn")
    speed = float(ego.get("speed_kmh") or 0)

    compact = {
        "mission": f"Drive to {_goal_name(state)}. Entering that whole block counts as arrived. India keep-left.",
        "route_rule": (
            f"At junction {for_junction} pick recommended_turn={best} (smallest remaining_m). "
            f"If goal_behind is true, NEVER go straight — turn toward {_goal_name(state)}. "
            f"Never pick a turn that increases remaining_m by more than {AWAY_SLACK_M} m."
        ),
        "recommended_turn": best,
        "why_asked": why,
        "latency": {
            "your_answer_arrives_in_s": state.get("horizon_s") or predicted.get("horizon_s") or 1.8,
            "your_avg_ms": (state.get("stream") or {}).get("avg_latency_ms"),
            "rule": "Decide for the pinned junction ids and predicted_at_horizon, never for the instant this snapshot was taken.",
        },
        "for_junction": for_junction,
        "after_next": after_next,
        "locked_turn": state.get("locked_turn"),
        "lock_in_s": route.get("lock_in_s"),
        "stage": state.get("stage"),
        "goal": {
            "name": _goal_name(state),
            "kind": goal.get("kind"),
            "short": goal.get("short"),
            "in_area": bool(goal.get("in_area")),
            "dist_m": goal.get("dist_m"),
            "screen_side": goal.get("screen_side"),
            "bearing_deg": goal.get("bearing_deg"),
        },
        "ego": {"speed_kmh": ego.get("speed_kmh"), "gear": ego.get("gear"), "yaw_deg": ego.get("yaw_deg")},
        "road": route.get("road"),
        "turn_options_now": _turn_option_rows(nj, costs, best),
        "planner_best": best,
        "shortest_exit_blocked": _shortest_exit_blocked(state, best if isinstance(best, str) else None),
        "follow_mode": resolve_trust(state) == "follow_jev",
        "goal_behind": abs(float(goal.get("bearing_deg") or 0)) > 100,
        "turn_after_next_plan": plan.get("turn_after_next"),
        "goal_on_current_segment": plan.get("goal_on_current_segment"),
        "signal_now": {"color": sig.get("color"), "seconds": sig.get("seconds"), "dist_stop_m": sig.get("dist_to_stop_m")},
        "predicted_at_horizon": predicted,
        "lead_vehicle": state.get("lead"),
        "lanes": state.get("lanes"),
        "last_blocked_action": state.get("last_blocked_action"),
        "surround_360": _trim_surround(state.get("surround")),
        "pedestrians": (state.get("pedestrians") or [])[:8],
        "previous_decision": {k: prev_d.get(k) for k in ("next_turn", "gear", "stage", "wait_reason") if k in prev_d},
    }

    questions: dict[str, Any] = {}
    asked: dict[str, bool] = {k: False for k in ASK_KEYS}

    unlocked = not state.get("is_locked") and not plan.get("goal_on_current_segment")
    crit = _legal_turn_criteria(nj, costs, best, state)
    follow = resolve_trust(state) == "follow_jev"
    if unlocked and len(crit) >= 2:
        if follow:
            questions["next_turn"] = _choice(
                f"FOLLOW: your answer is executed exactly. Junction {for_junction}. "
                f"Pick RANK 1 / recommended_turn={best} unless that exit is blocked in surround_360. "
                f"Do not omit. Do not pick a longer path for any other reason.",
                crit,
            )
        else:
            questions["next_turn"] = _choice(
                f"You are routing to {_goal_name(state)}. recommended_turn={best}. "
                f"Answer MUST be the BEST ROUTE (smallest remaining_m) unless that exit is blocked. "
                f"Do not take a longer path. Junction {for_junction}.",
                crit,
            )
        asked["next_turn"] = True

    if ask.get("turn_after_next") and after_next and plan.get("turn_after_next") != "park":
        crit2 = _legal_turn_criteria(an, {}, plan.get("turn_after_next") if plan.get("turn_after_next") in VALID_TURNS else None, state)
        if plan.get("turn_after_next") == "park" or plan.get("goal_on_current_segment"):
            crit2 = {"arrive": f"{_goal_name(state)} is on the next segment — enter that block, no further turn."}
        if len(crit2) >= 2:
            questions["turn_after_next"] = _choice(
                f"Choose the turn at the following junction {after_next} toward {_goal_name(state)}. Prefer {plan.get('turn_after_next')} if that arm is open.",
                crit2,
            )
            asked["turn_after_next"] = True

    if ask.get("speed_mode"):
        pace = _pace_criteria(state)
        if len(pace) >= 2:
            questions["speed_mode"] = _choice(
                "Pace until the next decision. Local code already stops for red lights and pedestrians — do not pick crawl just because a light is red if you were not asked about stopping.",
                pace,
            )
            asked["speed_mode"] = True

    if ask.get("gear") and speed >= 5:
        gears = _legal_gears(speed, str(ego.get("gear") or "1"))
        if len(gears) >= 2:
            questions["gear"] = _choice(
                "Pick a physically valid gear for ego.speed_kmh. After a stop the car already uses 1st.",
                gears,
            )
            asked["gear"] = True

    if ask.get("blocked_action") and (state.get("lead") or {}).get("blocking"):
        blocked = _blocked_criteria(state)
        if len(blocked) >= 2:
            questions["blocked_action"] = _choice(
                "Stationary lead on our green/none. Escalate wait → horn → change_lane like a real driver. Never change_lane if that option is absent.",
                blocked,
            )
            asked["blocked_action"] = True

    state["asked"] = asked

    state_text = (
        "You are the NAVIGATOR of an autonomous city car (OpenJEV / Codiv).\n"
        + (
            "FOLLOW MODE: pace, gear, and blocked_action are executed as you answer, even at 0% confidence.\n"
            "Your next_turn is used only if it is toward P. An opposite/detour pick is replaced with RANK 1.\n"
            "Local 60 Hz code only stops for red lights, pedestrians, and crash-avoidance.\n"
            if follow
            else "Your next_turn is used when confidence is high enough. A local 60 Hz executor owns steering, stop lines, and yields.\n"
        )
        + "Your answer lands ~1.5–2 s later — decide for predicted_at_horizon and the pinned junction ids, not 'now'.\n"
        "ROUTE: pick RANK 1 / recommended_turn (smallest remaining_m) unless shortest_exit_blocked is true.\n"
        "If goal_behind is true, P (the destination area) is behind you — NEVER go straight. Turn so remaining_m drops.\n"
        "Never pick an arm that is more than 40 m longer than RANK 1 — that is the opposite direction.\n"
        "SCREEN: +bearing / +lat = LEFT, −bearing / −lat = RIGHT.\n"
        "Keep previous_decision.next_turn unless remaining_m ranking changed or that exit is blocked.\n\n"
        f"DRIVE_STATE:\n{json.dumps(compact, separators=(',', ':'))}"
    )

    return {"model": model, "state": state_text, "questions": questions}


def _answers_to_controls(
    answers: dict[str, Any],
    latency_ms: float,
    model: str,
    state: dict[str, Any] | None = None,
) -> dict[str, Any]:
    st = state or {}
    asked = st.get("asked") or _ask_flags(st)
    route = st.get("route") or {}
    nj = route.get("next_junction") or {}
    trust = resolve_trust(st)
    thr = trust_thresholds(trust)
    dropped: list[str] = []
    confidences: dict[str, float] = {}

    def pick(qid: str) -> tuple[str | None, float]:
        a = answers.get(qid) or {}
        choice = a.get("choice")
        if choice is None:
            return None, 0.0
        conf = float(a.get("confidence") or 0.0)
        confidences[qid] = conf
        return str(choice), conf

    out: dict[str, Any] = {
        "for_junction": st.get("for_junction") or nj.get("id"),
        "after_next": st.get("after_next") or (route.get("after_next") or {}).get("id"),
        "source": f"jev:{model}",
        "latency_ms": round(latency_ms, 2),
        "asked": dict(asked),
        "confidences": confidences,
        "dropped": dropped,
        "hazard": "none",
        "trust": trust,
    }

    follow = trust == "follow_jev"

    nt_raw, c0 = pick("next_turn")
    if nt_raw is not None:
        if not follow and c0 < thr["turn"]:
            dropped.append(f"next_turn conf {c0:.2f}")
        else:
            nt = _norm_turn(nt_raw)
            if nt:
                out["next_turn"] = nt
                out["maneuver"] = nt

    tan_raw, c1 = pick("turn_after_next")
    if tan_raw is not None:
        if not follow and c1 < thr["turn"]:
            dropped.append(f"turn_after_next conf {c1:.2f}")
        else:
            tan = _norm_turn(tan_raw, allow_park=True)
            if tan:
                out["turn_after_next"] = tan

    sm_raw, c2 = pick("speed_mode")
    if sm_raw is not None:
        if not follow and c2 < thr["pace"]:
            dropped.append(f"speed_mode conf {c2:.2f}")
        else:
            sm = sm_raw.strip().lower()
            if sm in ("fast", "go", "crawl"):
                out["speed_mode"] = sm

    gear_raw, c3 = pick("gear")
    if gear_raw is not None:
        if not follow and c3 < thr["gear"]:
            dropped.append(f"gear conf {c3:.2f}")
        else:
            g = gear_raw.strip()
            if g in ("1", "2", "3", "4", "5"):
                speed = float((st.get("ego") or {}).get("speed_kmh") or 0)
                out["gear"] = "1" if speed < 5.0 else g

    ba_raw, c4 = pick("blocked_action")
    if ba_raw is not None:
        if not follow and c4 < thr["block"]:
            dropped.append(f"blocked_action conf {c4:.2f}")
        else:
            ba = ba_raw.strip().lower()
            if ba not in ("wait", "horn", "change_lane"):
                ba = "change_lane" if "lane" in ba else "horn" if "horn" in ba else "wait"
            out["blocked_action"] = ba

    confs = [c for c in confidences.values() if c > 0]
    out["confidence"] = min(confs) if confs else 0.0

    # Never execute an away-from-P turn. Snap to RANK 1 (including FOLLOW).
    plan = route.get("plan") or {}
    costs = plan.get("costs") or {}
    rec, rec_c = _recommended_turn(nj, costs)
    jammed = _shortest_exit_blocked(st, rec)
    nt = out.get("next_turn")
    if nt and rec and nt != rec and not jammed:
        if _turn_is_away(str(nt), costs.get(nt), rec, rec_c, st.get("goal") or {}):
            dropped.append(f"route snap {nt}->{rec} (away from P)")
            out["next_turn"] = rec
            out["maneuver"] = rec

    if dropped:
        out["note"] = " | ".join(dropped)
    for qid in confidences:
        out["asked"][qid] = True
    return out


def _sanitize_safety_only(remote: dict[str, Any], state: dict[str, Any]) -> dict[str, Any]:
    """Strip physically impossible bits. Do not invent a turn Jev did not choose."""
    out = dict(remote)
    fixes: list[str] = list(out.get("dropped") or [])
    sig = str((state.get("signal") or {}).get("color") or "NONE").upper()
    route = state.get("route") or {}
    lanes = state.get("lanes") or {}
    lead = state.get("lead") or {}
    nj = route.get("next_junction") or {}
    an = route.get("after_next") or {}
    plan = route.get("plan") or {}

    follow = resolve_trust(state) == "follow_jev"

    if not follow and out.get("speed_mode") == "fast":
        light = nj.get("light") or {}
        lead_d = float(lead.get("dist_m") or 999) if lead else 999
        turn = out.get("next_turn") or state.get("locked_turn") or plan.get("next_turn")
        turn_soon = turn != "straight" and float(nj.get("dist_stop_m") or 999) < 90
        if lead_d < 55 or turn_soon or sig in ("RED", "YELLOW") or (
            light and light.get("color") == "GREEN" and float(light.get("seconds") or 0) < float(nj.get("eta_s") or 0) + 2
        ):
            out["speed_mode"] = "go"
            fixes.append("fast denied (not open)")

    if out.get("blocked_action") == "change_lane":
        if not (lanes.get("change_allowed") and (lanes.get("alt") or {}).get("clear")):
            out["blocked_action"] = "horn" if lead.get("blocking") else "wait"
            fixes.append("lane change not clear")
        elif sig == "RED":
            out["blocked_action"] = "wait"
            fixes.append("no lane change on RED")
    if out.get("blocked_action") == "horn" and not lead.get("blocking"):
        out.pop("blocked_action", None)
        fixes.append("horn without blocking lead")

    def arm_open(turn: str | None, can: dict[str, Any]) -> bool:
        if not turn or turn == "park":
            return True
        return bool(can.get(f"can_{turn}", False))

    if "next_turn" in out and not arm_open(out.get("next_turn"), nj):
        if follow:
            out.pop("next_turn", None)
            out.pop("maneuver", None)
            fixes.append("next_turn arm closed — omitted (FOLLOW will not substitute)")
        else:
            rec, _ = _recommended_turn(nj, plan.get("costs") or {})
            if rec and arm_open(rec, nj):
                out["next_turn"] = rec
                out["maneuver"] = rec
                fixes.append(f"next_turn arm closed — used {rec}")
            else:
                out.pop("next_turn", None)
                out.pop("maneuver", None)
                fixes.append("next_turn arm closed — omitted")
    if "turn_after_next" in out and an and not arm_open(out.get("turn_after_next"), an):
        out.pop("turn_after_next", None)
        fixes.append("turn_after_next arm closed — omitted")

    out["sanitized"] = bool(fixes) and any("denied" in f or "closed" in f or "not clear" in f or "without" in f for f in fixes)
    out["fixes"] = fixes
    if fixes:
        out["note"] = " | ".join(fixes)
    return out


def _skip_stub(state: dict[str, Any], note: str) -> dict[str, Any]:
    nj = (state.get("route") or {}).get("next_junction") or {}
    an = (state.get("route") or {}).get("after_next") or {}
    return {
        "source": "jev:skipped",
        "for_junction": state.get("for_junction") or nj.get("id"),
        "after_next": state.get("after_next") or an.get("id"),
        "latency_ms": 0,
        "confidence": 1.0,
        "asked": {k: False for k in ASK_KEYS},
        "confidences": {},
        "dropped": [],
        "hazard": "none",
        "note": note,
    }


def _load_api_keys() -> list[str]:
    """CODIV_API_KEYS (comma/semicolon) plus CODIV_API_KEY, de-duplicated, order preserved."""
    seen: set[str] = set()
    out: list[str] = []
    raw = (os.getenv("CODIV_API_KEYS") or "") + "," + (os.getenv("CODIV_API_KEY") or "")
    for part in raw.replace(";", ",").split(","):
        k = part.strip()
        if k.startswith("sk-") and k not in seen:
            seen.add(k)
            out.append(k)
    return out


def _key_tag(i: int, key: str) -> str:
    return f"k{i + 1}/…{key[-4:]}"


class RateLimited(Exception):
    def __init__(self, retry_after: float) -> None:
        super().__init__("rate limited")
        self.retry_after = retry_after


class JevDriverClient:
    def __init__(self) -> None:
        self.url = os.getenv("CODIV_URL", "https://api.codiv.ai/v1/systemone")
        self.keys = _load_api_keys()
        self.api_key = self.keys[0] if self.keys else ""
        self.model = os.getenv("CODIV_MODEL", "laya-1.0")
        self.fallback_model = os.getenv("CODIV_MODEL_FALLBACK", "openjev-0.1")
        self.timeout = float(os.getenv("REQUEST_TIMEOUT_S", "3.5"))
        self.cooldown_s = float(os.getenv("CODIV_KEY_COOLDOWN_S", "20"))
        self.trust_default = resolve_trust({})
        self._rr = 0
        self._lock = threading.Lock()
        self._cool_until = [0.0] * len(self.keys)
        self._busy = [False] * len(self.keys)

    @property
    def trust(self) -> str:
        return self.trust_default

    def set_trust(self, mode: str) -> str:
        self.trust_default = _normalize_trust(mode)
        return self.trust_default

    @property
    def configured(self) -> bool:
        return bool(self.keys)

    @property
    def key_count(self) -> int:
        return len(self.keys)

    def keys_ready(self) -> int:
        now = time.monotonic()
        with self._lock:
            return sum(1 for i, until in enumerate(self._cool_until) if now >= until and not self._busy[i])

    def _pick_key(self) -> tuple[int, str] | None:
        n = len(self.keys)
        if n == 0:
            return None
        now = time.monotonic()
        with self._lock:
            for step in range(n):
                i = (self._rr + step) % n
                if not self._busy[i] and now >= self._cool_until[i]:
                    self._busy[i] = True
                    self._rr = (i + 1) % n
                    return i, self.keys[i]
        return None

    def _release(self, idx: int) -> None:
        with self._lock:
            if 0 <= idx < len(self._busy):
                self._busy[idx] = False

    def _cool(self, idx: int, seconds: float) -> None:
        with self._lock:
            if 0 <= idx < len(self._cool_until):
                self._cool_until[idx] = time.monotonic() + max(2.0, seconds)

    def decide(self, state: dict[str, Any]) -> dict[str, Any]:
        # Request trust overrides env; otherwise use server default (env / POST /drive/trust)
        if not state.get("trust"):
            state = {**state, "trust": self.trust_default}
        trust = resolve_trust(state)

        if trust == "planner_only":
            out = decide_local(state)
            out["source"] = "planner_only"
            out["trust"] = trust
            out["note"] = "planner_only — Codiv skipped"
            return out

        if not self.configured:
            out = decide_local(state)
            out["trust"] = trust
            out["note"] = "CODIV_API_KEY missing — local fallback"
            return out

        payload = build_payload(state, self.model)
        if not payload.get("questions"):
            stub = _skip_stub(state, "no legal question to ask")
            stub["trust"] = trust
            return stub

        picked = self._pick_key()
        if picked is None:
            last_err = "all keys busy or cooling"
            if trust == "follow_jev":
                stub = _skip_stub(state, f"Codiv failed ({last_err}) — holding for Jev")
                stub["trust"] = trust
                stub["source"] = "jev:pending"
                return stub
            out = decide_local(state)
            out["trust"] = trust
            out["note"] = f"Codiv failed ({last_err}) — local fallback"
            return out

        idx, key = picked
        tag = _key_tag(idx, key)
        try:
            out = self._post(payload, state, key)
            out["key_slot"] = tag
            out["trust"] = trust
            return out
        except RateLimited as exc:
            self._cool(idx, exc.retry_after)
            last_err = f"429 on {tag}"
            print(f"[JEV] {tag} rate-limited, cooling {exc.retry_after:.0f}s", flush=True)
        except requests.Timeout:
            last_err = f"timeout on {tag}"
            print(f"[JEV] {tag} timeout ({self.timeout}s) — local fallback this tick", flush=True)
        except requests.RequestException as exc:
            last_err = f"{tag} {exc}"
            print(f"[JEV] {tag} network: {exc} — local fallback this tick", flush=True)
        except RuntimeError as exc:
            msg = str(exc)
            last_err = f"{tag} {msg}"
            if "401" in msg or "403" in msg:
                self._cool(idx, 3600)
                print(f"[JEV] {tag} auth failed — parking key for 1h", flush=True)
            else:
                print(f"[JEV] {tag} {msg} — local fallback this tick", flush=True)
        finally:
            self._release(idx)

        if trust == "follow_jev":
            stub = _skip_stub(state, f"Codiv failed ({last_err}) — holding for Jev")
            stub["trust"] = trust
            stub["source"] = "jev:pending"
            return stub
        out = decide_local(state)
        out["trust"] = trust
        out["note"] = f"Codiv failed ({last_err}) — local fallback"
        return out

    def _post(self, payload: dict[str, Any], state: dict[str, Any], key: str) -> dict[str, Any]:
        headers = {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        t0 = time.perf_counter()
        resp = requests.post(self.url, headers=headers, json=payload, timeout=self.timeout)
        latency_ms = (time.perf_counter() - t0) * 1000
        if resp.status_code in (429, 529):
            retry = self.cooldown_s
            raw = resp.headers.get("Retry-After")
            if raw:
                try:
                    retry = max(retry, float(raw))
                except ValueError:
                    pass
            raise RateLimited(retry)
        if resp.status_code != 200:
            raise RuntimeError(f"HTTP {resp.status_code}: {resp.text[:240]}")
        data = resp.json()
        answers = data.get("answers") or {}
        remote = _answers_to_controls(answers, latency_ms, self.model, state)
        return _sanitize_safety_only(remote, state)
