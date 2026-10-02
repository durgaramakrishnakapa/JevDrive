# Dr. Drive — Jev / Codiv automation

Autonomous driving decisions via [Codiv System One](https://codiv.ai/) (OpenJEV / Laya).

## Setup (Windows)

```powershell
cd Automation
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# Edit .env: set CODIV_API_KEY and optional CODIV_API_KEYS (comma-separated, round-robin)
uvicorn server:app --host 127.0.0.1 --port 8787 --reload
```

Health check: http://127.0.0.1:8787/health

## Game wiring

1. Start this server.
2. Start the Vite game (`npm run dev`).
3. Click **AUTO** on the HUD — the car asks Jev only at real decisions (one request in flight).

Without a valid `CODIV_API_KEY`, Auto still works using `local_fallback.py`.

## Speed tips

| Setting | Recommendation |
|---------|----------------|
| `CODIV_MODEL` | `laya-1.0` (fast encoder, ~10ms model time) |
| Fallback | `openjev-0.1` if Laya errors |
| State size | Keep compact JSON (game already does) |
| Poll rate | Game polls ~300ms, not every frame |

## API

`POST /drive/decide` with drive state JSON → `{ throttle, brake, steer, gear, maneuver, hazard, source, latency_ms }`.

## Trust modes (`JEV_TRUST`)

| Mode | Meaning |
|------|---------|
| `strict_confidence` | Drop low-confidence answers (turn ≥ 0.62) |
| `soft_confidence` | Lower bar (turn ≥ 0.35) |
| `follow_jev` | Always apply Jev's legal choice (ignore confidence) |
| `planner_only` | Skip Codiv; local planner only |

Click **FOLLOW / STRICT / …** on the JEV BRAIN panel to cycle. Also `POST /drive/trust {"trust":"follow_jev"}`.

