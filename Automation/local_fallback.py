"""
Local fallback when Codiv is offline — uses the game's grid planner result
(route.plan) so the route stays goal-directed, plus simple pace / gear rules.
"""

from __future__ import annotations

from typing import Any

VALID = ("left", "right", "straight")


def decide_local(state: dict[str, Any]) -> dict[str, Any]:
    ego = state.get("ego") or {}
    signal = state.get("signal") or {}
    ahead = state.get("ahead") or []
    peds = state.get("pedestrians") or []
    route = state.get("route") or {}
    plan = route.get("plan") or {}
    nj = route.get("next_junction") or {}
    an = route.get("after_next") or {}
    surround = state.get("surround") or {}
    predicted = state.get("predicted") or {}

    speed = float(ego.get("speed_kmh") or 0)
    sig = str(signal.get("color") or "NONE").upper()
    pred_sig = str(predicted.get("signal_color") or sig).upper()
    stop_dist = float(signal.get("dist_to_stop_m") or 999)

    def allowed(turn: Any, can: dict[str, Any]) -> bool:
        return turn in VALID and bool(can.get(f"can_{turn}", True))

    next_turn = plan.get("next_turn") if allowed(plan.get("next_turn"), nj) else None
    if next_turn is None:
        legacy = (state.get("junction") or {}).get("plan")
        next_turn = legacy if allowed(legacy, nj) else next(
            (t for t in ("straight", "left", "right") if allowed(t, nj)), "straight"
        )

    tan = plan.get("turn_after_next")
    if tan not in ("park",) and not allowed(tan, an):
        tan = next((t for t in ("straight", "left", "right") if allowed(t, an)), "straight") if an else tan

    speed_mode = "go"
    hazard = "none"

    for p in peds:
        along = float(p.get("along_m") or 99)
        lat = abs(float(p.get("lat_m") or 9))
        on_path = p.get("crossing") or p.get("on_zebra")
        if on_path and -2 < along < 22 and lat < 9:
            hazard = "pedestrian"
            speed_mode = "stop"
            break
        if p.get("on_exit_zebra") and next_turn != "straight" and stop_dist < 14:
            hazard = "pedestrian"
            speed_mode = "stop"

    if hazard == "none" and ahead:
        d = float(ahead[0].get("dist_m") or 99)
        if d < 8:
            hazard = "rear_end"
            speed_mode = "stop"
        elif d < 14:
            speed_mode = "crawl"

    if hazard == "none" and next_turn == "right" and stop_dist < 14:
        if any(float(o.get("dist_m") or 99) < 30 for o in surround.get("oncoming") or []):
            hazard = "cross_traffic"
            speed_mode = "crawl"

    if hazard == "none" and (surround.get("in_box") or []) and stop_dist < 8:
        speed_mode = "crawl"

    if hazard == "none" and -2 < stop_dist < 40:
        if sig == "RED" or (sig == "YELLOW" and stop_dist > 6) or (sig == "GREEN" and pred_sig == "RED" and stop_dist > 12):
            hazard = "red_light"
            speed_mode = "stop"

    # Blocked by a stationary lead on green: wait → horn → change lane (same escalation Jev is asked for)
    lead = state.get("lead") or {}
    lanes = state.get("lanes") or {}
    blocked_action = "wait"
    if lead.get("blocking"):
        blocked_s = float(lead.get("blocked_s") or 0)
        horns = int(lead.get("horns") or 0)
        alt_ok = bool(lanes.get("change_allowed")) and bool((lanes.get("alt") or {}).get("clear"))
        near_line_right = next_turn == "right" and -1 < stop_dist < 30
        if blocked_s >= 3.0 and horns >= 1 and alt_ok and not near_line_right and sig != "RED":
            blocked_action = "change_lane"
        elif blocked_s >= 1.0:
            blocked_action = "horn"
        if hazard == "rear_end":
            hazard = "none"
            speed_mode = "go"

    # Open road → fast (gears 4/5)
    if speed_mode == "go" and hazard == "none":
        light = nj.get("light") or {}
        lead_d = float(lead.get("dist_m") or 999) if lead else 999
        ped_near = any(p.get("crossing") and 0 < float(p.get("along_m") or 99) < 50 for p in peds)
        green_ok = (not light) or (light.get("color") == "GREEN" and float(light.get("seconds") or 0) > float(nj.get("eta_s") or 0) + 2)
        if lead_d > 55 and not ped_near and next_turn == "straight" and green_ok and sig not in ("RED", "YELLOW"):
            speed_mode = "fast"

    if speed < 5 or speed_mode == "stop":
        gear = "1"
    elif speed_mode == "fast" and speed >= 84:
        gear = "5"
    elif speed_mode == "fast" and speed >= 62:
        gear = "4"
    elif speed < 23:
        gear = "1" if (next_turn != "straight" and stop_dist < 25) else "2"
    elif speed < 40:
        gear = "2"
    elif speed < 65:
        gear = "3"
    else:
        gear = "4"

    return {
        "next_turn": next_turn,
        "turn_after_next": tan,
        "for_junction": state.get("for_junction") or nj.get("id"),
        "after_next": state.get("after_next") or an.get("id"),
        "speed_mode": speed_mode,
        "blocked_action": blocked_action,
        "gear": gear,
        "hazard": hazard,
        "maneuver": next_turn,
        "source": "local_fallback",
        "latency_ms": 0,
        "confidence": 1.0,
    }
