import type { DriveInput, Gear } from "./vehicle";
import { GEAR_STATS, LIGHT_YELLOW, ROAD_WIDTH } from "./constants";
import { JEV_HORIZON_S, type DriveState, type PedInfo, type RouteContext, type SurroundObject } from "./driveSense";
import {
  buildTurnPath,
  laneErrors,
  laneHoldSteer,
  purePursuit,
  type LaneIndex,
  type Turn,
  type TurnPath,
} from "./routePlanner";

export type BlockedAction = "wait" | "horn" | "change_lane";

export type AutoMode = "manual" | "auto";
export type NextTurn = Turn;
export type Stage = "CRUISE" | "APPROACH" | "WAIT" | "TURN" | "RECOVER" | "PARK" | "DONE";

/** Decision returned by the Automation server (Jev / fallback) */
export interface JevDecision {
  next_turn?: string;
  turn_after_next?: string;
  speed_mode?: "go" | "crawl" | "stop" | string;
  blocked_action?: string;
  gear?: string;
  hazard?: string;
  for_junction?: string;
  after_next?: string;
  source?: string;
  latency_ms?: number;
  confidence?: number;
  note?: string;
  key_slot?: string;
  trust?: string;
  /** server-side safety sanitizer: did it change anything, and what */
  sanitized?: boolean;
  fixes?: string[];
  seq?: number;
  asked?: Record<string, boolean>;
  confidences?: Record<string, number>;
  dropped?: string[];
  // legacy fields, ignored for control
  throttle?: number;
  brake?: number;
  steer?: string;
  maneuver?: string;
}

export interface DriveDecision {
  throttle: number;
  brake: number;
  steer: string;
  steer_cmd: number;
  next_turn: Turn;
  gear: string;
  maneuver: string;
  hazard: string;
  stage: Stage;
  wait_reason: string;
  lane: LaneIndex;
  blocked_action: BlockedAction | "none";
  source: string;
  latency_ms: number;
}

const ENDPOINTS = ["http://127.0.0.1:8787/drive/decide", "/api/drive/decide"];

const V_CRUISE = 12.5; // m/s ≈ 45 km/h — default city pace
const V_FAST = 25.0; // m/s ≈ 90 km/h — open road, long green ahead (gears 4/5)
const V_THROUGH = 9.0; // straight through a green junction (default)
const V_THROUGH_FAST = 17.0; // straight through a long green on an empty road
const V_TURN_LEFT = 3.7;
const V_TURN_RIGHT = 4.8;
const A_BRAKE = 4.6; // comfortable stop decel
const A_TURN_DECEL = 2.6; // bleed speed on approach to a turn
const A_HARD = 6.2; // yellow "can we still stop" decel

const AWAY_SLACK_M = 40;

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function normTurn(raw: unknown): Turn | null {
  const s = String(raw ?? "").toLowerCase();
  if (s === "left" || s === "right" || s === "straight") return s;
  if (s.includes("left")) return "left";
  if (s.includes("right")) return "right";
  if (s.includes("straight") || s.includes("ahead")) return "straight";
  return null;
}

function labelSteer(cmd: number): string {
  if (cmd > 0.75) return "hard_left";
  if (cmd > 0.12) return "left";
  if (cmd < -0.75) return "hard_right";
  if (cmd < -0.12) return "right";
  return "straight";
}

/** Upshift points (≈80 % of each gear's top speed) and downshift points with hysteresis */
const UPSHIFT = [7.0, 12.0, 17.5, 23.5];
const DOWNSHIFT = [4.0, 9.0, 14.0, 20.0];

function gearForSpeed(v: number, current: string, eager: boolean): string {
  let g = Number(current);
  if (!Number.isFinite(g) || g < 1 || g > 5) g = 1;
  const up = eager ? 0.92 : 1; // on an open road shift a touch earlier
  while (g < 5 && v >= UPSHIFT[g - 1] * up) g++;
  while (g > 1 && v < DOWNSHIFT[g - 2]) g--;
  return String(g);
}

/** Send a Jev request every 0.3 s. Each in-flight call uses the next API key. */
export const JEV_CADENCE_S = 0.3;
const JEV_MAX_INFLIGHT_DEFAULT = 9;
const JEV_ABORT_MS = 4200;
/** How long a Jev answer stays "fresh" for pace / gear hints */
const JEV_FRESH_S = 3.0;
const JEV_MAX_APPLY_S = 3.2;
/** Route answers are allowed to land later — Codiv RTT is often 1.5–2.8 s. */
const JEV_ROUTE_APPLY_S = 5.2;

export type JevTrust = "strict_confidence" | "soft_confidence" | "follow_jev" | "planner_only";

const TRUST_CYCLE: JevTrust[] = ["strict_confidence", "soft_confidence", "follow_jev", "planner_only"];

const TRUST_TURN_FLOOR: Record<JevTrust, number> = {
  strict_confidence: 0.62,
  soft_confidence: 0.35,
  follow_jev: 0,
  planner_only: 1,
};

const TRUST_LABEL: Record<JevTrust, string> = {
  strict_confidence: "STRICT",
  soft_confidence: "SOFT",
  follow_jev: "FOLLOW",
  planner_only: "PLANNER",
};

interface AskFlags {
  next_turn: boolean;
  turn_after_next: boolean;
  speed_mode: boolean;
  gear: boolean;
  blocked_action: boolean;
}

interface JevTicket {
  seq: number;
  sentAt: number;
  jid: string | null;
  afterId: string | null;
  signalColor: string;
  asked: AskFlags;
  why: string[];
  x: number;
  z: number;
}

function anyAsk(a: AskFlags): boolean {
  return a.next_turn || a.turn_after_next || a.speed_mode || a.gear || a.blocked_action;
}

function emptyAsk(): AskFlags {
  return { next_turn: false, turn_after_next: false, speed_mode: false, gear: false, blocked_action: false };
}

export interface JevStats {
  requests: number;
  /** answered by Codiv (any model) */
  jev: number;
  /** Jev answers that passed the safety sanitizer untouched */
  clean: number;
  /** Jev answers the sanitizer had to fix (false red_light, closed arm, unsafe fast/lane change…) */
  fixed: number;
  /** server answered from the local rule engine (Codiv offline / timeout / rate limit) */
  fallback: number;
  /** no answer at all (server down, abort) */
  errors: number;
  /** answers that arrived after a newer one and were discarded */
  stale: number;
  /** Jev route choice agreed with the executed turn */
  routeAgree: number;
  routeTotal: number;
  /** answers dropped because the world no longer matched the ask */
  staleWorld: number;
  /** answers (or fields) dropped for low confidence */
  lowConf: number;
  inflight: number;
  avgLatencyMs: number;
  minLatencyMs: number;
  maxLatencyMs: number;
  /** measured answers per second */
  answerHz: number;
  /** measured requests per second */
  requestHz: number;
}

export interface JevLogEntry {
  t: number;
  seq: number;
  /** ✓ clean · ~ fixed · F fallback · ✕ error */
  verdict: "clean" | "fixed" | "fallback" | "error";
  for_junction: string | null;
  after_next: string | null;
  /** What this request asked Jev */
  asked: string;
  /** Raw Jev answer (turn / gear / pace) */
  jev_turn: string;
  jev_gear: string;
  jev_pace: string;
  /** What the car is actually doing right now */
  car_turn: string;
  car_gear: string;
  car_pace: string;
  car_source: string;
  next_turn: string;
  turn_after_next: string;
  gear: string;
  speed_mode: string;
  blocked_action: string;
  hazard: string;
  source: string;
  latency_ms: number;
  note: string;
  /** what the executor did with it */
  applied: string;
  /** identical consecutive answers folded into this row */
  repeats?: number;
}

/** Speed we may carry so that we can still stop in `d` metres at decel `a` */
function stopSpeed(d: number, a = A_BRAKE): number {
  return d <= 0 ? 0 : Math.sqrt(2 * a * d);
}

/** Anyone on the zebra / in our corridor — including jaywalkers after green. */
function pedInCorridor(p: PedInfo, alongMax = 22): boolean {
  const threat = p.crossing || p.on_zebra || p.on_exit_zebra;
  if (!threat) return false;
  if (p.along_m < -2.5 || p.along_m > alongMax) return false;
  return Math.abs(p.lat_m) < ROAD_WIDTH * 0.72;
}

/**
 * Bumper gap to the closest vehicle actually on our path (including ones already
 * turning through the same left/right). Used so we never occupy the same arc.
 */
function pathFollowGap(state: DriveState, inTurn: boolean): { dist: number; speed: number } | null {
  const half = (state.ego.length_m || 4.2) / 2;
  const latLim = inTurn ? 5.8 : 3.4;
  let bestDist = 80;
  let bestSpeed = 0;
  let found = false;
  const consider = (along: number, lat: number, speed: number, turning: boolean) => {
    if (along < 0.25) return;
    if (Math.abs(lat) > (turning || inTurn ? 5.8 : latLim)) return;
    const bumper = Math.max(0, along - half);
    if (!found || bumper < bestDist) {
      bestDist = bumper;
      bestSpeed = speed;
      found = true;
    }
  };
  const scan = (list: SurroundObject[]) => {
    for (const o of list) consider(o.along_m, o.lat_m, o.speed_kmh / 3.6, o.turning);
  };
  scan(state.surround.front);
  scan(state.surround.front_left);
  scan(state.surround.front_right);
  scan(state.surround.in_box);
  if (state.lead && (!found || state.lead.dist_m < bestDist)) {
    bestDist = state.lead.dist_m;
    bestSpeed = state.lead.speed_kmh / 3.6;
    found = true;
  }
  return found ? { dist: bestDist, speed: bestSpeed } : null;
}

/**
 * Autonomous driver: Jev = route/gear/pace brain (latency-aware), local = Tesla-style executor.
 */
export class AutoDriver {
  mode: AutoMode = "manual";
  stage: Stage = "CRUISE";
  blinker: "none" | "left" | "right" = "none";
  lastDecision: DriveDecision | null = null;
  lastError = "";
  lastLatencyMs = 0;
  waitReason = "";

  // outputs
  private throttle = 0;
  private brake = 0;
  private steer = 0;
  private pendingGear: Gear | null = null;
  private lastSentGear = "";

  // route commitments (pinned by junction id)
  private committed = new Map<string, Turn>();
  private jevPlan = new Map<string, { turn: Turn; conf: number; t: number }>();
  private commitSource = new Map<string, string>();

  // Jev session (pipelined stream)
  private time = 0;
  private seq = 0;
  private lastSendT = -99;
  private lastAppliedSeq = 0;
  private inflight = new Map<number, JevTicket>();
  /** Caps parallel Codiv calls to the number of API keys (from /health). */
  private maxInflight = JEV_MAX_INFLIGHT_DEFAULT;
  /** How hard we trust Jev's confidence score */
  trust: JevTrust = "follow_jev";
  private lastLogKey = "";
  private lastLogT = -99;
  private recentAnswers: number[] = [];
  private recentRequests: number[] = [];
  stats: JevStats = AutoDriver.freshStats();
  private jevGear: string | null = null;
  private jevSpeedMode: string | null = null;
  private jevHazard = "none";
  private jevAge = 99;
  private jevSource = "";
  private jevNote = "";
  /** Rolling Jev decision log for the HUD */
  log: JevLogEntry[] = [];
  fastMode = false;
  private prevState: Partial<DriveState> | null = null;
  private prevDecision: Partial<DriveDecision> | null = null;
  private lastDriveState: DriveState | null = null;

  // turn execution
  private path: TurnPath | null = null;
  private turnKind: Turn = "straight";
  private turnTimer = 0;
  private recoverTimer = 0;
  private lastJunctionId = "";

  // launch
  private mustStartInFirst = true;
  private launchedAt = -99;

  // lanes / blocked-lead handling
  targetLane: LaneIndex = 1;
  private laneChangedAt = -99;
  private leadId = -1;
  private leadStoppedS = 0;
  private blockedS = 0;
  private hornCount = 0;
  private lastHornT = -99;
  private hornQueue = 0;
  private jevBlockedAction: BlockedAction | null = null;
  private jevBlockedAt = -99;
  private lastBlockedAction: BlockedAction | "none" = "none";
  /** Recorded so Jev sees our own last action and the result */
  private passingId = -1;

  setMode(mode: AutoMode) {
    this.mode = mode;
    this.throttle = 0;
    this.brake = 0;
    this.steer = 0;
    this.pendingGear = null;
    this.path = null;
    this.stage = "CRUISE";
    this.blinker = "none";
    this.waitReason = "";
    this.committed.clear();
    this.jevPlan.clear();
    this.commitSource.clear();
    this.jevGear = null;
    this.jevSpeedMode = null;
    this.jevHazard = "none";
    this.jevAge = 99;
    this.lastError = "";
    this.prevState = null;
    this.prevDecision = null;
    this.lastDriveState = null;
    this.mustStartInFirst = true;
    this.lastDecision = null;
    this.targetLane = 1;
    this.leadId = -1;
    this.leadStoppedS = 0;
    this.blockedS = 0;
    this.hornCount = 0;
    this.hornQueue = 0;
    this.jevBlockedAction = null;
    this.passingId = -1;
    this.fastMode = false;
    if (mode === "auto") {
      this.pendingGear = "1";
      this.log = [];
      this.stats = AutoDriver.freshStats();
      this.seq = 0;
      this.lastAppliedSeq = 0;
      this.inflight.clear();
      this.lastSendT = -99;
      this.lastLogKey = "";
      this.recentAnswers = [];
      this.recentRequests = [];
      this.refreshKeyPool();
    }
  }

  /** Cycle: STRICT → SOFT → FOLLOW → PLANNER → … */
  cycleTrust(): JevTrust {
    const i = TRUST_CYCLE.indexOf(this.trust);
    this.trust = TRUST_CYCLE[(i + 1) % TRUST_CYCLE.length];
    this.jevPlan.clear();
    return this.trust;
  }

  setTrust(mode: string): JevTrust {
    const m = String(mode || "").toLowerCase().replace(/-/g, "_") as JevTrust;
    if (TRUST_CYCLE.includes(m)) this.trust = m;
    return this.trust;
  }

  trustLabel(): string {
    return TRUST_LABEL[this.trust];
  }

  /** Match parallel Codiv calls to how many API keys the Automation server has. */
  private refreshKeyPool() {
    void fetch("http://127.0.0.1:8787/health")
      .then((r) => (r.ok ? r.json() : null))
      .then((h: { codiv_keys?: number } | null) => {
        const n = Number(h?.codiv_keys);
        if (Number.isFinite(n) && n >= 1) this.maxInflight = Math.max(1, Math.min(16, Math.floor(n)));
      })
      .catch(() => undefined);
  }

  private turnConfFloor(): number {
    return TRUST_TURN_FLOOR[this.trust];
  }

  /** Live: what the car is executing this frame (not a stale Jev tick). */
  liveFollow(): { turn: string; gear: string; pace: string; source: string; stage: string; wait: string } {
    const d = this.lastDecision;
    const pace = this.fastMode ? "fast" : this.jevSpeedMode ?? "go";
    return {
      turn: (d?.next_turn ?? "straight").toUpperCase(),
      gear: d?.gear ?? this.jevGear ?? "-",
      pace,
      source: d?.source ?? "-",
      stage: d?.stage ?? this.stage,
      wait: d?.wait_reason ?? "",
    };
  }

  private askedLabel(ask: AskFlags): string {
    const bits: string[] = [];
    if (ask.next_turn) bits.push("turn");
    if (ask.turn_after_next) bits.push("next");
    if (ask.speed_mode) bits.push("pace");
    if (ask.gear) bits.push("gear");
    if (ask.blocked_action) bits.push("block");
    return bits.join("+") || "none";
  }

  private followFields() {
    const f = this.liveFollow();
    return {
      car_turn: f.turn,
      car_gear: f.gear,
      car_pace: f.pace,
      car_source: f.source,
    };
  }

  private static freshStats(): JevStats {
    return {
      requests: 0,
      jev: 0,
      clean: 0,
      fixed: 0,
      fallback: 0,
      errors: 0,
      stale: 0,
      staleWorld: 0,
      lowConf: 0,
      routeAgree: 0,
      routeTotal: 0,
      inflight: 0,
      avgLatencyMs: 0,
      minLatencyMs: 0,
      maxLatencyMs: 0,
      answerHz: 0,
      requestHz: 0,
    };
  }

  /** Game drains this each frame to play the horn + notify traffic */
  consumeHorn(): boolean {
    if (this.hornQueue <= 0) return false;
    this.hornQueue--;
    return true;
  }

  private honk() {
    if (this.time - this.lastHornT < 2.2) return;
    this.lastHornT = this.time;
    this.hornCount++;
    this.hornQueue++;
  }

  toggle(): AutoMode {
    this.setMode(this.mode === "auto" ? "manual" : "auto");
    return this.mode;
  }

  sampleInput(): DriveInput {
    return { throttle: this.throttle, brake: this.brake, steer: this.steer, handbrake: false };
  }

  consumeGear(): Gear | null {
    const g = this.pendingGear;
    this.pendingGear = null;
    return g;
  }

  /** Un-narrowed stage read (TS narrows `this.stage` after assignments) */
  private stageNow(): Stage {
    return this.stage;
  }

  inTurnOrRecover(): boolean {
    return this.stage === "TURN" || this.stage === "RECOVER";
  }

  /* ------------------------------------------------------------ */

  update(dt: number, state: DriveState | null, ctx: RouteContext | null) {
    if (this.mode !== "auto" || !state || !ctx) return;
    this.time += dt;
    this.jevAge += dt;
    this.lastDriveState = state;

    const v = Math.max(0, state.ego.speed_kmh / 3.6);
    const J = ctx.junction;
    const RJ = state.route.next_junction;

    // Housekeeping when we move on to a new junction
    if (J && J.id !== this.lastJunctionId) {
      this.lastJunctionId = J.id;
    }

    // Launch bookkeeping: any full stop → next pull-away in 1st
    if (v < 0.8) {
      this.mustStartInFirst = true;
      this.launchedAt = this.time;
    } else if (this.mustStartInFirst && v > 6.5 && this.time - this.launchedAt > 0.8) {
      this.mustStartInFirst = false;
    }

    // ---- 1. Resolve/lock the turn for the next junction ----
    const followMode = this.trust === "follow_jev";
    let turn: Turn = "straight";
    let turnSrc = "plan";
    if (J) {
      const r = this.resolveTurn(J.id, J.can, state);
      turn = r.turn;
      turnSrc = r.source;
      const lockDist = Math.max(12, v * 2.0 + 6);
      const haveJev = this.trust !== "planner_only" && this.jevPlan.has(J.id);
      const legalN = (["left", "right", "straight"] as Turn[]).filter((t) => J.can[t]).length;
      const mustLock = J.distStop < 6;
      // Lock the toward-P turn at the line. Jev may relock before TURN if it agrees with remaining_m.
      if (!this.committed.has(J.id) && J.distStop < lockDist && (haveJev || mustLock || legalN === 1 || this.trust === "planner_only" || followMode)) {
        this.committed.set(J.id, turn);
        this.commitSource.set(J.id, turnSrc);
        this.noteRouteOutcome(J.id, turn);
      }
    }

    // ---- 2. Stage machine ----
    const goalAhead = state.route.plan.goal_on_current_segment ? state.route.plan.goal_ahead_m ?? null : null;
    if (this.stageNow() === "DONE") {
      // parked — stay
    } else if (this.stage === "TURN") {
      this.turnTimer += dt;
      if (!this.path || this.turnTimer > 10) {
        this.stage = "RECOVER";
        this.recoverTimer = 0;
        this.path = null;
      }
    } else if (this.stage === "RECOVER") {
      this.recoverTimer += dt;
      if ((Math.abs(ctx.lane.lat) < 0.6 && Math.abs(ctx.lane.head) < 0.1) || this.recoverTimer > 4.5) {
        this.stage = "CRUISE";
      }
    } else if (state.goal.in_area || state.goal.dist_m < 28 || (goalAhead !== null && goalAhead < 40)) {
      this.stage = "PARK";
    } else if (!J) {
      this.stage = "CRUISE";
    } else if (J.distStop < Math.max(55, (v * v) / (2 * A_BRAKE) + 25)) {
      // approach window grows with speed so signal logic always has braking room
      if (this.stage !== "WAIT") this.stage = "APPROACH";
    } else {
      this.stage = "CRUISE";
    }

    // ---- 3. Longitudinal: hazards, signals, yields → target speed ----
    let vTarget = V_FAST; // capped back to V_CRUISE below unless the road is open
    let hazard = "none";
    let waitReason = "";

    // ---- Lead vehicle tracking (stateful: how long has it been sitting there?) ----
    const L = state.lead;
    if (L && L.id === this.leadId) {
      if (L.speed_kmh < 3) this.leadStoppedS += dt;
      else this.leadStoppedS = 0;
    } else {
      this.leadId = L ? L.id : -1;
      this.leadStoppedS = 0;
      this.blockedS = 0;
      this.hornCount = 0;
    }
    const weAreStuck = !!L && L.blocking && v < 1.2 && L.dist_m < 16 && !(J && (J.inBox || J.distStop < -1));
    if (weAreStuck) this.blockedS += dt;
    else this.blockedS = Math.max(0, this.blockedS - dt * 2);
    if (L) {
      L.stopped_s = Math.round(this.leadStoppedS * 10) / 10;
      L.blocked_s = Math.round(this.blockedS * 10) / 10;
      L.horns = this.hornCount;
    }
    state.lanes.target = this.targetLane;

    // Lead vehicle gap control (lane-aware; falls back to the legacy front list)
    const leadGap = L ? { dist_m: L.dist_m, leadV: L.speed_kmh / 3.6 } : null;
    const legacy = state.ahead.find((a) => a.same_lane);
    const gapSrc =
      leadGap ?? (legacy ? { dist_m: legacy.dist_m, leadV: Math.max(0, v + legacy.rel_speed_kmh / 3.6) } : null);
    if (gapSrc) {
      const gapTarget = 5 + v * 1.1;
      if (gapSrc.dist_m < gapTarget) {
        vTarget = Math.min(vTarget, Math.max(0, gapSrc.leadV - 0.5), stopSpeed(gapSrc.dist_m - 3.5));
        if (gapSrc.dist_m < 5.5) {
          hazard = "rear_end";
          waitReason = "vehicle ahead";
        }
      } else {
        vTarget = Math.min(vTarget, gapSrc.leadV + Math.max(0, (gapSrc.dist_m - gapTarget) * 0.35));
      }
    }

    // ---- Blocked by a stationary lead on green: horn, then overtake via the other lane ----
    let blockedAction: BlockedAction | "none" = "none";
    const turnForLanes: Turn = J ? this.committed.get(J.id) ?? state.route.plan.next_turn : "straight";
    if (weAreStuck && L) {
      const lanes = state.lanes;
      const nearLine = !!J && J.distStop < 30 && J.distStop > -1;
      // A right turn (crossing the junction) must start from lane 1 — never pass a stopped lead
      // on its curb side right before turning across its nose.
      const laneOk =
        lanes.change_allowed &&
        lanes.alt.clear &&
        !(turnForLanes === "right" && nearLine && lanes.alt.index === 2) &&
        this.time - this.laneChangedAt > 4;
      const jevFresh = followMode
        ? !!this.jevBlockedAction
        : !!(this.jevBlockedAction && this.time - this.jevBlockedAt < 7);
      let action: BlockedAction = "wait";
      if (followMode) {
        // FOLLOW: Jev's blocked_action is the whole policy. Do not escalate locally.
        action = jevFresh ? this.jevBlockedAction! : "wait";
      } else if (jevFresh) {
        action = this.jevBlockedAction!;
        if (action === "wait" && this.blockedS > 10) action = laneOk ? "change_lane" : "horn";
      } else {
        if (this.blockedS > 1.3) action = "horn";
        if (this.blockedS > 3.2 && this.hornCount >= 1) action = laneOk ? "change_lane" : "horn";
      }
      if (action === "change_lane" && !laneOk) action = "horn";
      if (action === "horn") {
        if (this.blockedS > 1.0) this.honk();
        blockedAction = "horn";
      } else if (action === "change_lane") {
        this.targetLane = lanes.alt.index;
        this.laneChangedAt = this.time;
        this.passingId = L.id;
        this.blockedS = 0;
        blockedAction = "change_lane";
      } else {
        blockedAction = "wait";
      }
      if (waitReason === "" || waitReason === "vehicle ahead") waitReason = `lead stopped ${this.blockedS.toFixed(0)}s`;
    }
    this.lastBlockedAction = blockedAction;

    // ---- Return to lane 1 (default lane; required for right turns) once the pass is done ----
    if (this.targetLane === 2 && state.lanes.current === 2 && this.stage !== "TURN") {
      const passed = this.passingId < 0 || !state.surround.front.some((o) => o.id === this.passingId) && !(L && L.id === this.passingId);
      const lane1 = state.lanes.alt; // alt of lane 2 is lane 1
      const lane1Clear = lane1.clear && lane1.free_ahead_m > 18;
      const needLane1 = turnForLanes === "right" && !!J && J.distStop < 45;
      if (passed && lane1Clear && this.time - this.laneChangedAt > 3 && state.lanes.change_allowed) {
        this.targetLane = 1;
        this.laneChangedAt = this.time;
        this.passingId = -1;
      } else if (needLane1 && !lane1Clear && J && J.distStop < 22) {
        // can't get into lane 1 for the right turn: wait for a gap (don't turn across lane 1 traffic)
        vTarget = Math.min(vTarget, stopSpeed(Math.max(J.distStop - 2, 0), 3));
        if (J.distStop < 8) waitReason = "waiting for lane 1 gap";
      }
    }

    // Pedestrians in our path — yield even after green (jaywalkers). Never hit them.
    const halfLen = (state.ego.length_m || 4.2) / 2;
    for (const p of state.pedestrians) {
      if (!pedInCorridor(p, 28)) continue;
      const bumperGap = p.along_m - halfLen - 1.6;
      vTarget = Math.min(vTarget, stopSpeed(Math.max(bumperGap, 0), A_HARD));
      if (p.along_m < 14) {
        hazard = "pedestrian";
        waitReason = "pedestrian";
      }
      if (p.along_m < 8) vTarget = 0;
    }

    // ---- Open-road assessment: may we use the high gears? ----
    const crossingPedAhead = state.pedestrians.some(
      (p) => pedInCorridor(p, 50) || ((p.crossing || p.on_zebra) && p.along_m > -2 && p.along_m < 50 && Math.abs(p.lat_m) < 12),
    );
    const leadFar = !L || L.dist_m > 55 || L.speed_kmh / 3.6 > 16;
    const laneSettled = state.lanes.current === this.targetLane;
    let junctionOpen = true;
    if (J && J.distStop < 95) {
      const sig = RJ?.light;
      // ETA at the pace we'd actually carry if we open up
      const etaFast = Math.max(0, J.distStop) / clamp(v + 6, 12, 22);
      junctionOpen =
        turn === "straight" &&
        (!sig || sig.color === "NONE" || (sig.color === "GREEN" && sig.seconds + LIGHT_YELLOW * 0.6 > etaFast + 1.0)) &&
        state.surround.in_box.length === 0 &&
        !state.cross.some((c) => c.crossing || c.eta_s < 3);
    }
    const openRoad =
      (this.stage === "CRUISE" || this.stage === "APPROACH") &&
      laneSettled && leadFar && !crossingPedAhead && junctionOpen && hazard === "none";
    // Jev owns the pace. FOLLOW: only Jev's "fast" unlocks V_FAST. Other modes may open up if Jev is silent.
    const jevAllowsFast = followMode
      ? this.jevSpeedMode === "fast"
      : this.jevAge >= JEV_FRESH_S || this.jevSpeedMode === "fast";
    const fast = followMode ? this.jevSpeedMode === "fast" && hazard === "none" : openRoad && jevAllowsFast;
    if (followMode) {
      if (this.jevSpeedMode !== "fast") vTarget = Math.min(vTarget, V_CRUISE);
    } else if (!fast) {
      vTarget = Math.min(vTarget, V_CRUISE);
    }

    // Signal + junction entry rules
    let holdAtLine = false;
    // Already over the line / in the box: keep moving. Do not re-read the other road's red.
    const pastLine = !!J && J.distStop < -1.5;
    if (J && (this.stage === "APPROACH" || this.stage === "WAIT") && !pastLine) {
      const dRaw = J.distStop;
      // Stop with the front bumper ~0.8 m before the line, never on the zebra
      const d = dRaw - halfLen - 0.8;
      const sig = RJ?.light;
      if (sig && dRaw > -1.2) {
        const eta = Math.max(0, d) / Math.max(v, 0.6);
        const canStop = d > v * v / (2 * A_HARD) - 0.5;
        if (sig.color === "RED") {
          holdAtLine = true;
          waitReason = "red light";
        } else if (sig.color === "YELLOW") {
          if (canStop && d > 1.5) {
            holdAtLine = true;
            waitReason = "yellow — stopping";
          }
        } else if (sig.color === "GREEN") {
          // Will it be red when we get there? Stop only if we comfortably can.
          if (sig.seconds + LIGHT_YELLOW * 0.7 < eta && canStop && d > 6) {
            holdAtLine = true;
            waitReason = "green ending";
          }
        }
      }

      // Box occupied by another vehicle on OUR path → don't enter yet
      if (!holdAtLine && d < 4 && d > -1.2 && state.surround.in_box.some((o) => o.turning || (o.along_m > 0 && Math.abs(o.lat_m) < 3.4 && Math.abs(o.rel_heading_deg) < 55))) {
        holdAtLine = true;
        waitReason = "box occupied";
      }
      // Cross traffic with no signal control
      if (!holdAtLine && (!sig || sig.color === "NONE") && d < 6 && d > -1.2) {
        if (state.cross.some((c) => c.crossing || c.eta_s < 2.2)) {
          holdAtLine = true;
          waitReason = "cross traffic";
        }
      }
      // Pedestrians on THIS zebra — hold even on GREEN (jaywalkers after the light)
      if (!holdAtLine && d < 12 && d > -1.2) {
        if (state.pedestrians.some((p) => pedInCorridor(p, 16))) {
          holdAtLine = true;
          waitReason = "pedestrian on zebra";
        }
      }
      // Turning: pedestrians on the exit zebra
      if (!holdAtLine && turn !== "straight" && d < 8 && d > -1.2) {
        if (state.pedestrians.some((p) => p.on_exit_zebra || pedInCorridor(p, 18))) {
          holdAtLine = true;
          waitReason = "pedestrian on exit";
        }
      }
      // Right turn must yield to oncoming traffic
      if (!holdAtLine && turn === "right" && d < 5 && d > -1.2) {
        const threat = state.surround.oncoming.find((o) => o.dist_m < 30 && o.closing_kmh > 2);
        if (threat) {
          holdAtLine = true;
          waitReason = "yield oncoming";
        }
      }

      // Don't start a same-direction turn into a vehicle already on that arc
      const follow = pathFollowGap(state, true);
      if (!holdAtLine && turn !== "straight" && d < 8 && follow && follow.dist < 5.2) {
        vTarget = Math.min(vTarget, Math.max(0, follow.speed - 0.3), stopSpeed(follow.dist - 2.4, A_HARD));
        if (follow.dist < 3.4) {
          holdAtLine = true;
          waitReason = "follow same turn";
        } else {
          waitReason = waitReason || "follow same turn";
        }
      }

      if (holdAtLine) {
        vTarget = Math.min(vTarget, stopSpeed(d));
        if (waitReason.includes("pedestrian")) hazard = "pedestrian";
        else if (hazard === "none") hazard = waitReason.includes("light") || waitReason.includes("green") || waitReason.includes("yellow") ? "red_light" : "cross_traffic";
        if (v < 0.6 && d < 3) this.stage = "WAIT";
      } else {
        if (this.stage === "WAIT") this.stage = "APPROACH";
        if (turn === "straight") {
          vTarget = Math.min(vTarget, fast ? V_THROUGH_FAST : V_THROUGH);
        } else {
          const vt = turn === "left" ? V_TURN_LEFT : V_TURN_RIGHT;
          vTarget = Math.min(vTarget, Math.sqrt(vt * vt + 2 * A_TURN_DECEL * Math.max(d, 0)));
        }
        // Begin the turn when the front bumper reaches the stop line, slow enough,
        // and nobody is occupying the same left/right arc.
        if (turn !== "straight" && dRaw - halfLen <= 1.0) {
          const exit = ctx.exits[turn];
          const vt = turn === "left" ? V_TURN_LEFT : V_TURN_RIGHT;
          const followNow = pathFollowGap(state, true);
          const arcClear = !followNow || followNow.dist > 4.4;
          if (exit && v <= vt + 1.6 && arcClear) {
            this.path = buildTurnPath({ x: state.ego.x, z: state.ego.z, yaw: (state.ego.yaw_deg * Math.PI) / 180 }, exit, turn);
            this.turnKind = turn;
            this.turnTimer = 0;
            this.stage = "TURN";
            this.targetLane = 1; // exits always rejoin lane 1
            this.passingId = -1;
          } else if (exit) {
            vTarget = Math.min(vTarget, vt, followNow ? Math.max(0, followNow.speed - 0.2) : vt);
          }
        }
      }
      // Indicate like a real driver: ~45 m before the line, held through WAIT and the turn,
      // cleared when the turn completes (RECOVER) or the plan changes to straight.
      this.blinker = turn !== "straight" && dRaw < 45 ? turn : "none";
    }

    // Jev pace hint (never overrides safety). FOLLOW keeps the last pace until Jev sends a new one.
    const paceLive = followMode ? this.jevSpeedMode != null : this.jevAge < JEV_FRESH_S;
    if (paceLive && hazard === "none" && !holdAtLine) {
      if (this.jevSpeedMode === "crawl") vTarget = Math.min(vTarget, 4.5);
      if (this.jevSpeedMode === "stop" && this.jevHazard !== "red_light") vTarget = Math.min(vTarget, 2.5);
    }

    // ---- 4. Lateral ----
    let steerCmd = 0;
    let maneuver = "straight";
    if (this.stage === "TURN" && this.path) {
      const look = clamp(2.6 + v * 0.55, 3, 6.5);
      const pp = purePursuit(this.path, state.ego.x, state.ego.z, (state.ego.yaw_deg * Math.PI) / 180, look);
      steerCmd = pp.steer;
      maneuver = this.turnKind;
      const vt = this.turnKind === "left" ? V_TURN_LEFT : V_TURN_RIGHT;
      // slow mid-turn, ease out
      vTarget = Math.min(vTarget, vt * (0.85 + 0.35 * Math.abs(pp.progress - 0.5)));
      // Stay behind anyone already on this same left/right — never occupy their arc
      const follow = pathFollowGap(state, true);
      if (follow) {
        const need = 4.4 + v * 0.55;
        if (follow.dist < need) {
          vTarget = Math.min(vTarget, Math.max(0, follow.speed - 0.4), stopSpeed(follow.dist - 2.6, A_HARD));
        }
        if (follow.dist < 3.0) {
          vTarget = 0;
          waitReason = "vehicle in turn";
        }
      }
      // Mid-turn yields: oncoming while still early in a right turn, or pedestrian ahead
      if (this.turnKind === "right" && pp.progress < 0.4) {
        const threat = state.surround.oncoming.find((o) => o.dist_m < 14 && o.closing_kmh > 2);
        if (threat) {
          vTarget = 0;
          waitReason = "yield oncoming";
        }
      }
      if (state.pedestrians.some((p) => pedInCorridor(p, 12))) {
        vTarget = 0;
        hazard = "pedestrian";
        waitReason = "pedestrian";
      }
      if (pp.progress >= 0.97 || (pp.progress > 0.7 && Math.abs(pp.exitHeadErr) < 0.16 && pp.remaining < 4)) {
        this.stage = "RECOVER";
        this.recoverTimer = 0;
        this.path = null;
        this.blinker = "none";
      }
    } else if (this.stage === "PARK") {
      const dist = state.goal.dist_m;
      if (state.goal.in_area || dist < 1) {
        vTarget = Math.min(vTarget, 3.5);
        steerCmd = laneHoldSteer(ctx.lane, v);
        maneuver = "arrive";
        this.stage = "DONE";
      } else {
        steerCmd = laneHoldSteer(ctx.lane, v);
        vTarget = Math.min(vTarget, 7);
        maneuver = "arrive";
      }
    } else if (this.stageNow() === "DONE") {
      vTarget = Math.min(vTarget, 3);
      steerCmd = laneHoldSteer(ctx.lane, v);
      maneuver = "arrived";
    } else {
      const laneErr =
        this.targetLane === 1
          ? ctx.lane
          : laneErrors(ctx.frame, state.ego.x, state.ego.z, (state.ego.yaw_deg * Math.PI) / 180, this.targetLane);
      steerCmd = laneHoldSteer(laneErr, v);
      // wheels straight while stopped / creeping at the line
      if (v < 1.5) steerCmd *= clamp(v / 1.5, 0.15, 1);
      const changing = Math.abs(laneErr.lat) > 1.2 && state.lanes.current !== this.targetLane;
      if (changing) {
        this.blinker = laneErr.lat > 0 ? "left" : "right";
        vTarget = Math.min(vTarget, 7); // gentle merge speed
        maneuver = `lane_change_${this.targetLane}`;
      } else if (this.stage === "CRUISE" || (this.stage === "APPROACH" && turn === "straight")) {
        this.blinker = "none";
        maneuver = this.stage.toLowerCase();
      } else {
        maneuver = this.stage === "APPROACH" && turn !== "straight" ? `intent_${turn}` : this.stage.toLowerCase();
      }
    }

    // ---- 5. Speed controller ----
    const err = vTarget - v;
    let tThrottle = 0;
    let tBrake = 0;
    if (vTarget < 0.3) {
      tThrottle = 0;
      tBrake = v > 0.35 ? clamp(0.55 + v * 0.12, 0.55, 1) : 0.7;
    } else if (err > 0.25) {
      tThrottle = clamp(0.22 + err * 0.28, 0, this.mustStartInFirst ? 0.9 : 1);
      tBrake = 0;
    } else if (err < -0.35) {
      tThrottle = 0;
      tBrake = clamp(-err * 0.32, 0.12, 1);
    } else {
      tThrottle = 0.1;
      tBrake = 0;
    }
    if (hazard === "rear_end" || hazard === "pedestrian") tBrake = Math.max(tBrake, 0.85);

    // ---- 6. Gear (FOLLOW: Jev's gear until replaced; other modes: Jev if near the speed gear)
    const bySpeed = gearForSpeed(v, state.ego.gear, fast);
    let gear = bySpeed;
    if (v < 1.5 || this.mustStartInFirst) {
      gear = "1";
    } else if (followMode && this.jevGear) {
      const stats = GEAR_STATS[this.jevGear];
      if (stats && v <= stats.maxSpeed * 1.02) gear = this.jevGear;
    } else if (vTarget < v - 4 && Number(bySpeed) > 2 && (holdAtLine || turn !== "straight")) {
      gear = String(Number(bySpeed) - 1);
    } else if (this.jevGear && this.jevAge < JEV_FRESH_S) {
      const jg = Number(this.jevGear);
      const sg = Number(bySpeed);
      const stats = GEAR_STATS[this.jevGear];
      if (Number.isFinite(jg) && Math.abs(jg - sg) <= 1 && stats && v <= stats.maxSpeed * 0.98) gear = this.jevGear;
    }
    if (gear !== this.lastSentGear && ["1", "2", "3", "4", "5"].includes(gear)) {
      if (gear !== state.ego.gear) this.pendingGear = gear as Gear;
      this.lastSentGear = gear;
    }
    this.fastMode = fast;

    // ---- 7. Smooth outputs ----
    if (tBrake < 0.05 && this.brake > 0.3) this.brake = 0;
    else this.brake += (tBrake - this.brake) * Math.min(1, dt * 12);
    if (tThrottle > 0.2 && this.throttle < 0.15 && tBrake < 0.1) this.throttle = tThrottle;
    else this.throttle += (tThrottle - this.throttle) * Math.min(1, dt * 9);
    const steerRate = this.stage === "TURN" ? 18 : 12;
    this.steer += (steerCmd - this.steer) * Math.min(1, dt * steerRate);

    this.waitReason = waitReason;
    const dec: DriveDecision = {
      throttle: tThrottle,
      brake: tBrake,
      steer: labelSteer(steerCmd),
      steer_cmd: steerCmd,
      next_turn: turn,
      gear,
      maneuver,
      hazard,
      stage: this.stage,
      wait_reason: waitReason,
      lane: this.targetLane,
      blocked_action: blockedAction,
      source: J ? this.commitSource.get(J.id) ?? turnSrc : "local",
      latency_ms: this.lastLatencyMs,
    };
    this.lastDecision = dec;
    // Ask Jev at the end of the frame so it sees the fully annotated state (lead timers, lane target)
    this.scheduleJev(state, J ? J.id : null, state.route.after_next?.id ?? null);
    this.prevDecision = { ...dec };
    this.prevState = {
      ego: { ...state.ego },
      signal: { ...state.signal },
      junction: { ...state.junction },
      goal: { ...state.goal },
      lead: state.lead ? { ...state.lead } : null,
    };
  }

  /* ------------------------------------------------------------ */

  /** Shortest arm to P is only "blocked" when we would drive straight into a stopped lead. */
  private shortestExitBlocked(turn: Turn, state: DriveState): boolean {
    return turn === "straight" && !!state.lead?.blocking;
  }

  /** True if this arm goes away from P vs the shortest remaining_m (or P is behind and this is straight). */
  private isAwayFromP(turn: Turn, state: DriveState, can: Record<Turn, boolean>): boolean {
    const best = state.route.plan.next_turn;
    if (turn === best) return false;
    const behind = Math.abs(state.goal.bearing_deg) > 100;
    if (behind && turn === "straight" && can[best] && best !== "straight") return true;
    const wc = state.route.plan.costs[turn];
    const bc = state.route.plan.costs[best];
    if (typeof wc === "number" && typeof bc === "number" && wc > bc + AWAY_SLACK_M) return true;
    if (typeof wc === "number" && wc > state.goal.dist_m + 100) return true;
    return false;
  }

  private towardTurns(can: Record<Turn, boolean>, state: DriveState): Turn[] {
    const best = state.route.plan.next_turn;
    const out: Turn[] = [];
    for (const t of ["left", "right", "straight"] as Turn[]) {
      if (!can[t]) continue;
      if (!this.isAwayFromP(t, state, can)) out.push(t);
    }
    if (!out.length && can[best]) out.push(best);
    return out;
  }

  /**
   * Keep Jev's legal pick unless it goes away from P — then snap to the shortest remaining_m.
   */
  private smartTurn(wanted: Turn, can: Record<Turn, boolean>, state: DriveState): Turn {
    if (!can[wanted]) {
      const legal = (["left", "right", "straight"] as Turn[]).filter((t) => can[t]);
      return legal[0] ?? "straight";
    }
    const best = state.route.plan.next_turn;
    if (wanted === best || !can[best]) return wanted;
    if (this.isAwayFromP(wanted, state, can) && !this.shortestExitBlocked(best, state)) {
      return best;
    }
    return wanted;
  }

  private resolveTurn(jid: string, can: Record<Turn, boolean>, state: DriveState): { turn: Turn; source: string } {
    const locked = this.committed.get(jid);
    if (locked) return { turn: locked, source: this.commitSource.get(jid) ?? "locked" };
    const plan = state.route.plan;
    const legal = (["left", "right", "straight"] as Turn[]).filter((t) => can[t]);
    if (legal.length === 1) return { turn: legal[0], source: "only" };
    const toward = this.towardTurns(can, state);
    if (toward.length === 1) return { turn: toward[0], source: "only-toward-p" };
    const best = plan.next_turn;
    const jev = this.trust === "planner_only" ? undefined : this.jevPlan.get(jid);

    if (jev && can[jev.turn]) {
      const accept = this.trust === "follow_jev" || jev.conf >= this.turnConfFloor();
      if (accept) {
        const turn = this.smartTurn(jev.turn, can, state);
        return { turn, source: turn === jev.turn ? this.jevSource || "jev" : "jev-best" };
      }
    }
    if (can[best]) return { turn: best, source: jev ? "plan(waiting jev)" : "plan" };
    return { turn: toward[0] ?? legal[0] ?? "straight", source: "plan" };
  }

  /** Only ask Jev when code does not already know the answer. */
  private buildAsk(state: DriveState, jid: string | null, locked: boolean): { ask: AskFlags; why: string[] } {
    const ask = emptyAsk();
    const why: string[] = [];
    if (this.trust === "planner_only") return { ask, why };
    const stage = this.stageNow();
    if (stage === "TURN" || stage === "RECOVER" || stage === "PARK" || stage === "DONE") return { ask, why };

    const nj = state.route.next_junction;
    const plan = state.route.plan;
    const pastLine = !!nj && nj.dist_stop_m < -1.5;
    const follow = this.trust === "follow_jev";
    const routeWindow = !!nj && nj.dist_stop_m > -1 && nj.dist_stop_m < (follow ? 240 : 140);
    const floor = this.turnConfFloor();
    const canMap: Record<Turn, boolean> = {
      left: !!nj?.can_left,
      right: !!nj?.can_right,
      straight: !!nj?.can_straight,
    };
    const toward = this.towardTurns(canMap, state);

    // Keep asking while two toward-P options exist. FOLLOW re-asks every cadence tick.
    if (jid && !locked && !pastLine && !nj?.in_box && !plan.goal_on_current_segment && routeWindow && toward.length >= 2) {
      const have = this.jevPlan.get(jid);
      const fresh = follow ? false : !!have && this.time - have.t < 12 && have.conf >= floor;
      if (!fresh) {
        ask.next_turn = true;
        why.push(`route ${jid}`);
      }
    }

    const an = state.route.after_next;
    if (an && !this.committed.has(an.id) && plan.turn_after_next !== "park") {
      const legal2 = [an.can_left, an.can_right, an.can_straight].filter(Boolean).length;
      const have2 = this.jevPlan.get(an.id);
      const fresh2 = follow ? false : !!have2 && this.time - have2.t < 14 && have2.conf >= floor;
      if (legal2 >= 2 && !fresh2 && (ask.next_turn || locked || routeWindow)) {
        ask.turn_after_next = true;
        why.push(`after ${an.id}`);
      }
    }

    const L = state.lead;
    if (L?.blocking && this.blockedS > 0.7) {
      ask.blocked_action = true;
      why.push("blocking lead");
    }

    const hardStop =
      this.lastDecision?.hazard === "pedestrian" ||
      (this.lastDecision?.wait_reason ?? "").includes("red") ||
      (this.lastDecision?.wait_reason ?? "").includes("yellow");
    if (!hardStop && (stage === "CRUISE" || stage === "APPROACH")) {
      ask.speed_mode = true;
      why.push("pace");
    }

    const vKmh = state.ego.speed_kmh;
    if (!this.mustStartInFirst && vKmh > 8 && (stage === "CRUISE" || stage === "APPROACH")) {
      ask.gear = true;
      why.push("gear");
    }

    if (follow && this.jevSpeedMode == null && (stage === "CRUISE" || stage === "APPROACH")) {
      ask.speed_mode = true;
      if (!why.includes("pace")) why.push("pace");
    }
    if (follow && !this.jevGear && !this.mustStartInFirst && vKmh > 8 && (stage === "CRUISE" || stage === "APPROACH")) {
      ask.gear = true;
      if (!why.includes("gear")) why.push("gear");
    }

    return { ask, why };
  }

  /**
   * 0.3 s cadence. Up to one in-flight Codiv call per API key (round-robin on the server).
   */
  private scheduleJev(state: DriveState, jid: string | null, afterId: string | null) {
    if (this.inflight.size >= this.maxInflight) return;
    const locked = jid ? this.committed.has(jid) : true;
    const { ask, why } = this.buildAsk(state, jid, locked);
    if (!anyAsk(ask)) return;
    if (this.time - this.lastSendT < JEV_CADENCE_S) return;
    this.lastSendT = this.time;
    void this.fetchDecision(state, jid, afterId, locked, ask, why);
  }

  /** Age of the oldest outstanding request (−1 if none) */
  pendingSeconds(): number {
    let oldest = -1;
    for (const t of this.inflight.values()) {
      const age = this.time - t.sentAt;
      if (age > oldest) oldest = age;
    }
    return oldest;
  }

  private bumpRate(buf: number[]): number {
    buf.push(this.time);
    const cutoff = this.time - 2.0;
    while (buf.length && buf[0] < cutoff) buf.shift();
    return buf.length / 2.0;
  }

  private pushLog(entry: JevLogEntry, force = false) {
    const key = `${entry.verdict}|${entry.jev_turn}|${entry.car_turn}|${entry.jev_gear}|${entry.car_gear}|${entry.jev_pace}|${entry.applied}`;
    if (!force && key === this.lastLogKey && this.time - this.lastLogT < 1.2) {
      if (this.log.length) {
        this.log[0].latency_ms = entry.latency_ms;
        this.log[0].seq = entry.seq;
        this.log[0].repeats = (this.log[0].repeats ?? 1) + 1;
        this.log[0].car_turn = entry.car_turn;
        this.log[0].car_gear = entry.car_gear;
        this.log[0].car_pace = entry.car_pace;
        this.log[0].car_source = entry.car_source;
      }
      return;
    }
    this.lastLogKey = key;
    this.lastLogT = this.time;
    this.log.unshift(entry);
    if (this.log.length > 16) this.log.length = 16;
    console.info(
      `[JEV #${entry.seq}] ASK ${entry.asked} → ${entry.jev_turn} G${entry.jev_gear} ${entry.jev_pace} | CAR ${entry.car_turn} G${entry.car_gear} ${entry.car_pace} (${entry.car_source}) · ${Math.round(entry.latency_ms)}ms · ${entry.applied}`,
    );
  }

  private async fetchDecision(
    state: DriveState,
    jid: string | null,
    afterId: string | null,
    locked: boolean,
    ask: AskFlags,
    why: string[],
  ) {
    const seq = ++this.seq;
    const sentAt = this.time;
    const ticket: JevTicket = {
      seq,
      sentAt,
      jid,
      afterId,
      signalColor: state.signal.color,
      asked: { ...ask },
      why: [...why],
      x: state.ego.x,
      z: state.ego.z,
    };
    this.inflight.set(seq, ticket);
    this.stats.requests++;
    this.stats.inflight = this.inflight.size;
    this.stats.requestHz = this.bumpRate(this.recentRequests);
    const ctrl = new AbortController();
    const timer = window.setTimeout(() => ctrl.abort(), JEV_ABORT_MS);
    const horizon = this.stats.avgLatencyMs ? Math.max(1.2, Math.min(2.8, this.stats.avgLatencyMs / 1000)) : JEV_HORIZON_S;
    const body = {
      ...state,
      ask,
      why,
      trust: this.trust,
      last_blocked_action: this.lastBlockedAction,
      for_junction: jid,
      after_next: afterId,
      locked_turn: jid ? this.committed.get(jid) ?? null : null,
      committed_turn: jid ? this.committed.get(jid) ?? null : null,
      is_locked: locked,
      horizon_s: horizon,
      stage: this.stage,
      previous_state: this.prevState,
      previous_decision: this.prevDecision,
      stream: {
        seq,
        cadence_ms: Math.round(JEV_CADENCE_S * 1000),
        inflight: this.inflight.size,
        last_applied_seq: this.lastAppliedSeq,
        avg_latency_ms: Math.round(this.stats.avgLatencyMs),
        answers_per_s: Number(this.stats.answerHz.toFixed(1)),
        stale_dropped: this.stats.stale,
        game_time_s: Number(this.time.toFixed(1)),
        sent_at_ms: Date.now(),
      },
    };
    let lastErr = "";
    try {
      for (const url of ENDPOINTS) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: ctrl.signal,
          });
          if (!res.ok) {
            lastErr = `HTTP ${res.status}`;
            continue;
          }
          const data = (await res.json()) as JevDecision;
          this.onJevAnswer(data, ticket);
          return;
        } catch (e) {
          lastErr = e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : "offline";
        }
      }
      this.lastError = lastErr || "offline";
      this.stats.errors++;
      const car = this.followFields();
      this.pushLog({
        t: this.time,
        seq,
        verdict: "error",
        for_junction: jid,
        after_next: afterId,
        asked: this.askedLabel(ask),
        jev_turn: "-",
        jev_gear: "-",
        jev_pace: "-",
        ...car,
        next_turn: car.car_turn,
        turn_after_next: "-",
        gear: car.car_gear,
        speed_mode: car.car_pace,
        blocked_action: "-",
        hazard: "-",
        source: "error",
        latency_ms: (this.time - sentAt) * 1000,
        note: this.lastError,
        applied: "ignored — car kept current plan",
      });
    } finally {
      clearTimeout(timer);
      this.inflight.delete(seq);
      this.stats.inflight = this.inflight.size;
    }
  }

  private onJevAnswer(data: JevDecision, ticket: JevTicket) {
    const rtt = (this.time - ticket.sentAt) * 1000;
    this.stats.answerHz = this.bumpRate(this.recentAnswers);
    const srcRaw = String(data.source || "jev");
    const slot = String(data.key_slot || "").trim();
    const src = slot ? `${srcRaw} ${slot}` : srcRaw;
    if (src === "jev:skipped") return;
    if (src === "jev:pending") return;
    const isFallback = !src.startsWith("jev") && !src.startsWith("codiv");
    if (isFallback) this.stats.fallback++;
    else this.stats.jev++;

    if (this.trust === "follow_jev" && isFallback) {
      const car = this.followFields();
      this.pushLog({
        t: this.time,
        seq: ticket.seq,
        verdict: "fallback",
        for_junction: ticket.jid,
        after_next: ticket.afterId,
        asked: this.askedLabel(ticket.asked),
        jev_turn: "-",
        jev_gear: "-",
        jev_pace: "-",
        ...car,
        next_turn: car.car_turn,
        turn_after_next: "-",
        gear: car.car_gear,
        speed_mode: car.car_pace,
        blocked_action: "-",
        hazard: "-",
        source: src,
        latency_ms: Number(data.latency_ms) || rtt,
        note: "planner fallback ignored",
        applied: "ignored",
      });
      return;
    }

    const lat = Number(data.latency_ms) || rtt;
    if (lat > 0) {
      this.stats.avgLatencyMs = this.stats.avgLatencyMs ? this.stats.avgLatencyMs * 0.85 + lat * 0.15 : lat;
      this.stats.minLatencyMs = this.stats.minLatencyMs ? Math.min(this.stats.minLatencyMs, lat) : lat;
      this.stats.maxLatencyMs = Math.max(this.stats.maxLatencyMs, lat);
    }

    if (ticket.seq <= this.lastAppliedSeq) {
      this.stats.stale++;
      return;
    }

    const ageS = this.time - ticket.sentAt;
    const routeTicket = ticket.asked.next_turn || ticket.asked.turn_after_next;
    const maxAge = routeTicket ? JEV_ROUTE_APPLY_S : JEV_MAX_APPLY_S;
    if (ageS > maxAge) {
      this.stats.stale++;
      const car = this.followFields();
      this.pushLog({
        t: this.time,
        seq: ticket.seq,
        verdict: "error",
        for_junction: ticket.jid,
        after_next: ticket.afterId,
        asked: this.askedLabel(ticket.asked),
        jev_turn: String(data.next_turn ?? "-"),
        jev_gear: String(data.gear ?? "-"),
        jev_pace: String(data.speed_mode ?? "-"),
        ...car,
        next_turn: car.car_turn,
        turn_after_next: "-",
        gear: car.car_gear,
        speed_mode: car.car_pace,
        blocked_action: "-",
        hazard: "-",
        source: src,
        latency_ms: lat,
        note: "too late — car kept current plan",
        applied: "dropped",
      });
      return;
    }

    this.lastAppliedSeq = ticket.seq;
    this.applyJev(data, ticket, lat, isFallback);
  }

  private applyJev(data: JevDecision, ticket: JevTicket, lat: number, isFallback: boolean) {
    const now = this.time;
    if (data.trust) this.setTrust(String(data.trust));
    const conf = Number(data.confidence) || 0;
    const forJ = data.for_junction || ticket.jid;
    const dropped = Array.isArray(data.dropped) ? data.dropped.map(String) : [];
    if (dropped.some((d) => d.includes("conf"))) this.stats.lowConf++;

    const applied: string[] = [];
    const follow = this.trust === "follow_jev";
    // FOLLOW: apply Jev's turn whenever it is present — ignore confidence, even 0%.
    let nt = normTurn(data.next_turn);
    const sense = this.lastDriveState;
    const nj = sense?.route.next_junction;
    if (nt && sense && nj && String(nj.id) === String(forJ)) {
      const can: Record<Turn, boolean> = {
        left: !!nj.can_left,
        right: !!nj.can_right,
        straight: !!nj.can_straight,
      };
      if (!can[nt]) {
        applied.push(`turn dropped (illegal ${nt})`);
        nt = null;
      } else {
        const snapped = this.smartTurn(nt, can, sense);
        if (snapped !== nt) applied.push(`snap ${nt}→${snapped} (toward P)`);
        nt = snapped;
      }
    }
    if (nt && forJ) {
      const worldOk = !ticket.jid || forJ === ticket.jid || forJ === this.lastJunctionId;
      const canRelock =
        this.stage !== "TURN" &&
        this.stage !== "RECOVER" &&
        this.stage !== "PARK" &&
        this.stage !== "DONE";
      if (!worldOk) {
        this.stats.staleWorld++;
        applied.push("turn dropped (wrong junction)");
      } else {
        this.jevPlan.set(forJ, { turn: nt, conf: follow ? 1 : (data.confidences?.next_turn ?? conf), t: now });
        const locked = this.committed.get(forJ);
        if (!locked) {
          applied.push(`J${forJ} plan ${nt}`);
        } else if (locked === nt) {
          applied.push(`J${forJ} agrees (${locked})`);
        } else if (canRelock) {
          this.committed.set(forJ, nt);
          this.commitSource.set(forJ, this.jevSource || "jev");
          applied.push(`J${forJ} relock ${locked}→${nt}`);
        } else {
          applied.push(`J${forJ} locked ${locked}`);
        }
      }
    }

    const afterJ = data.after_next || ticket.afterId;
    const nt2 = normTurn(data.turn_after_next);
    if (nt2 && afterJ && !this.committed.has(afterJ)) {
      this.jevPlan.set(afterJ, { turn: nt2, conf: follow ? 1 : (data.confidences?.turn_after_next ?? conf), t: now });
      applied.push(`J${afterJ} pre-plan ${nt2}`);
    } else if (String(data.turn_after_next ?? "").toLowerCase() === "park") {
      applied.push("park next");
    }

    const sigFlip = ticket.asked.speed_mode && ticket.signalColor === "GREEN" && (this.waitReason.includes("red") || this.waitReason.includes("yellow"));
    const paceOk = !sigFlip;

    const fixes = Array.isArray(data.fixes) ? data.fixes.map(String) : [];
    const sanitized = Boolean(data.sanitized);
    const verdict: JevLogEntry["verdict"] = isFallback ? "fallback" : sanitized ? "fixed" : "clean";
    if (!isFallback) {
      if (sanitized) this.stats.fixed++;
      else this.stats.clean++;
    }

    this.pushLog({
      t: now,
      seq: ticket.seq,
      verdict,
      for_junction: forJ ?? null,
      after_next: afterJ ?? null,
      asked: this.askedLabel(ticket.asked),
      jev_turn: ticket.asked.next_turn ? String(normTurn(data.next_turn) ?? data.next_turn ?? "-").toUpperCase() : "-",
      jev_gear: ticket.asked.gear ? String(data.gear ?? "-") : "-",
      jev_pace: ticket.asked.speed_mode ? String(data.speed_mode ?? "-") : "-",
      ...this.followFields(),
      next_turn: this.liveFollow().turn,
      turn_after_next: nt2 ?? (afterJ ? this.jevPlan.get(afterJ)?.turn : undefined) ?? String(data.turn_after_next ?? "-"),
      gear: this.liveFollow().gear,
      speed_mode: this.liveFollow().pace,
      blocked_action: String(data.blocked_action ?? "-"),
      hazard: String(data.hazard ?? "-"),
      source: String(data.source || "jev"),
      latency_ms: lat,
      note: [...fixes, ...(data.note ? [String(data.note)] : [])].filter((s, i, a) => s && a.indexOf(s) === i).join(" | "),
      applied: applied.join(", ") || (dropped.length ? `dropped ${dropped.join(",")}` : "applied"),
    });

    if (data.gear && ["1", "2", "3", "4", "5"].includes(String(data.gear))) this.jevGear = String(data.gear);
    const ba = String(data.blocked_action ?? "").toLowerCase();
    if (ba === "wait" || ba === "horn" || ba === "change_lane") {
      this.jevBlockedAction = ba;
      this.jevBlockedAt = now;
    }
    if ((follow || paceOk) && data.speed_mode) this.jevSpeedMode = data.speed_mode;
    this.jevNote = String(data.note ?? "");
    this.jevHazard = data.hazard ?? "none";
    this.jevAge = 0;
    this.jevSource = String(data.source || "jev").replace("codiv:", "jev:");
    this.lastLatencyMs = lat;
    this.lastError = "";
  }

  /** Called by the executor when a junction turn is locked: did Jev's route match? */
  private noteRouteOutcome(jid: string, executed: Turn) {
    const jev = this.jevPlan.get(jid);
    if (!jev) return;
    this.stats.routeTotal++;
    if (jev.turn === executed) this.stats.routeAgree++;
  }

  statusLine(): string {
    if (this.mode !== "auto") return "";
    const d = this.lastDecision;
    if (!d) return "AUTO · JEV starting…";
    const src = d.source.startsWith("jev") ? d.source : `${d.source}`;
    const turn = d.next_turn !== "straight" || d.stage === "TURN" ? d.next_turn.toUpperCase() : "straight";
    const wait = d.wait_reason ? ` · ${d.wait_reason}` : "";
    const act = d.blocked_action !== "none" ? ` · ${d.blocked_action.toUpperCase()}` : "";
    const lane = d.lane === 2 ? " · L2" : "";
    const fastTag = this.fastMode ? " · FAST" : "";
    const ms = this.lastLatencyMs > 0 ? ` · ${Math.round(this.lastLatencyMs)}ms` : this.lastError ? ` · ${this.lastError}` : "";
    const note = !src.startsWith("jev") && this.jevNote ? ` · ${this.jevNote.slice(0, 48)}` : "";
    return `AUTO · ${d.stage} · ${turn} (${src}) · G${d.gear}${fastTag}${lane}${wait}${act}${ms}${note}`;
  }

  /** Header line for the Jev panel: link + live stream figures */
  jevHeader(): string {
    const s = this.stats;
    const link = this.lastError && s.inflight === 0 ? `OFFLINE (${this.lastError})` : this.jevSource ? this.jevSource.toUpperCase() : "connecting…";
    const mode = ` · ${TRUST_LABEL[this.trust]}`;
    const hz = s.requestHz ? ` · ${s.requestHz.toFixed(1)} Hz` : "";
    const avg = s.avgLatencyMs ? ` · ${Math.round(s.avgLatencyMs)} ms` : "";
    const fly = s.inflight ? ` · ${s.inflight} in flight` : "";
    return `${link}${mode}${hz}${avg}${fly}`;
  }

  /** Scoreboard for the Jev panel: how many answers the AI got right vs fallback */
  jevScore(): { label: string; value: string; cls?: string }[] {
    const s = this.stats;
    const jevN = s.jev;
    const answered = s.jev + s.fallback + s.errors;
    const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "–");
    return [
      { label: "trust", value: TRUST_LABEL[this.trust], cls: this.trust === "follow_jev" ? "good" : this.trust === "strict_confidence" ? "warn" : "" },
      { label: "asks", value: String(s.requests) },
      { label: "jev AI", value: `${jevN} (${pct(jevN, answered)})`, cls: "good" },
      { label: "clean ✓", value: `${s.clean} (${pct(s.clean, Math.max(1, jevN))})`, cls: "good" },
      { label: "fixed ~", value: String(s.fixed), cls: s.fixed ? "warn" : "" },
      { label: "fallback", value: `${s.fallback} (${pct(s.fallback, answered)})`, cls: s.fallback ? "warn" : "" },
      { label: "errors", value: String(s.errors), cls: s.errors ? "bad" : "" },
      { label: "stale", value: String(s.stale + s.staleWorld) },
      { label: "route ok", value: s.routeTotal ? `${s.routeAgree}/${s.routeTotal}` : "–" },
      { label: "latency", value: s.avgLatencyMs ? `${Math.round(s.minLatencyMs)}–${Math.round(s.maxLatencyMs)}` : "–" },
    ];
  }
}
