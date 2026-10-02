"""
Dr. Drive — Jev automation server.

POST /drive/decide  { ...DriveState } -> control decision
GET  /health

Run:
  cd Automation
  python -m venv venv
  venv\\Scripts\\activate   # Windows
  pip install -r requirements.txt
  copy .env.example .env   # then set CODIV_API_KEY
  uvicorn server:app --host 127.0.0.1 --port 8787 --reload
"""

from __future__ import annotations

import os
import sys
from typing import Any

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field

from jev_client import JevDriverClient, TRUST_MODES
from local_fallback import decide_local

load_dotenv()

# Windows consoles are often cp1252 — never let a log line crash a request
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        pass

app = FastAPI(title="Dr. Drive Jev Automation", version="1.0.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

client = JevDriverClient()


class DriveState(BaseModel):
    """Game DriveState. Extra fields (route, surround, predicted, for_junction, …) pass through."""

    model_config = ConfigDict(extra="allow")

    goal: dict[str, Any] = Field(default_factory=dict)
    ego: dict[str, Any] = Field(default_factory=dict)
    signal: dict[str, Any] = Field(default_factory=dict)
    ahead: list[dict[str, Any]] = Field(default_factory=list)
    cross: list[dict[str, Any]] = Field(default_factory=list)
    pedestrians: list[dict[str, Any]] = Field(default_factory=list)
    junction: dict[str, Any] = Field(default_factory=dict)
    route: dict[str, Any] = Field(default_factory=dict)
    lead: dict[str, Any] | None = None
    lanes: dict[str, Any] = Field(default_factory=dict)
    last_blocked_action: str | None = None
    surround: dict[str, Any] = Field(default_factory=dict)
    predicted: dict[str, Any] = Field(default_factory=dict)
    rules: str | None = None
    previous_state: dict[str, Any] | None = None
    previous_decision: dict[str, Any] | None = None
    committed_turn: str | None = None
    locked_turn: str | None = None
    for_junction: str | None = None
    after_next: str | None = None
    is_locked: bool | None = None
    horizon_s: float | None = None
    stage: str | None = None
    ask: dict[str, Any] = Field(default_factory=dict)
    why: list[str] = Field(default_factory=list)
    trust: str | None = None
    stream: dict[str, Any] = Field(default_factory=dict)


class TrustBody(BaseModel):
    trust: str


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "ok": True,
        "codiv_configured": client.configured,
        "codiv_keys": client.key_count,
        "codiv_keys_ready": client.keys_ready(),
        "timeout_s": client.timeout,
        "trust": client.trust,
        "trust_modes": list(TRUST_MODES),
        "model": client.model,
        "fallback_model": client.fallback_model,
    }


@app.post("/drive/trust")
def set_trust(body: TrustBody) -> dict[str, Any]:
    mode = client.set_trust(body.trust)
    return {"ok": True, "trust": mode, "trust_modes": list(TRUST_MODES)}


def _log_decision(state: dict[str, Any], out: dict[str, Any]) -> None:
    """One line per decision on the server console — the Jev brain's audit trail."""
    ego = state.get("ego") or {}
    sig = state.get("signal") or {}
    nj = (state.get("route") or {}).get("next_junction") or {}
    lead = state.get("lead") or {}
    src = str(out.get("source", "?"))
    slot = out.get("key_slot") or ""
    lat = out.get("latency_ms") or 0
    conf = out.get("confidence")
    conf_s = f" conf={conf:.2f}" if isinstance(conf, (int, float)) and conf else ""
    lead_s = f" lead={lead.get('kind')}@{lead.get('dist_m')}m{' BLOCKING' if lead.get('blocking') else ''}" if lead else ""
    st = state.get("stream") or {}
    seq_s = f" seq={st.get('seq', '-')} inf={st.get('inflight', '-')}"
    print(
        f"[JEV] {src:<22} {slot:<10} trust={out.get('trust', '-'):<18} {lat:>6.0f}ms{conf_s} | {seq_s} | "
        f"v={ego.get('speed_kmh', 0):>3} G{ego.get('gear', '?')} stage={state.get('stage', '-')} "
        f"sig={sig.get('color', '-')}/{sig.get('seconds', '-')}s stop={nj.get('dist_stop_m', '-')}m{lead_s} | "
        f"J{out.get('for_junction', '-')}->{str(out.get('next_turn', '-')).upper()} "
        f"then J{out.get('after_next', '-')}->{out.get('turn_after_next', '-')} "
        f"gear={out.get('gear', '-')} pace={out.get('speed_mode', '-')} blocked={out.get('blocked_action', '-')} "
        f"hazard={out.get('hazard', '-')}"
        + (f" | {out.get('note')}" if out.get("note") else ""),
        flush=True,
    )


@app.post("/drive/decide")
async def drive_decide(body: DriveState) -> dict[str, Any]:
    state = body.model_dump()
    try:
        out = await run_in_threadpool(client.decide, state)
    except Exception as exc:  # noqa: BLE001
        out = decide_local(state)
        out["note"] = f"server error: {exc}"
    _log_decision(state, out)
    return out


if __name__ == "__main__":
    import uvicorn

    host = os.getenv("HOST", "127.0.0.1")
    port = int(os.getenv("PORT", "8787"))
    uvicorn.run("server:app", host=host, port=port, reload=True)
