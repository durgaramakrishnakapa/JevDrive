import type { CityWorld } from "./world";
import { approachArmFromTravel } from "./world";
import type { TrafficSystem } from "./traffic";
import type { PedestrianSystem } from "./pedestrians";
import type { Vehicle } from "./vehicle";
import { LIGHT_YELLOW, ROAD_WIDTH } from "./constants";
import {
  HEADING_NAME,
  alongOnFrame,
  currentRoadFrame,
  goalAheadOnSegment,
  goalRoad,
  insideJunctionBox,
  laneErrors,
  laneIndexAt,
  nextJunction,
  planAtJunction,
  type ExitPose,
  type JunctionInfo,
  type RoadFrame,
  type Turn,
} from "./routePlanner";

export type { Turn } from "./routePlanner";

/** Jev decision horizon — real Codiv round-trip is ~1.5–2 s */
export const JEV_HORIZON_S = 1.8;

export type SignalColor = "RED" | "YELLOW" | "GREEN" | "NONE";

export interface LeadInfo {
  id: number;
  kind: string;
  /** bumper-ish gap along our lane */
  dist_m: number;
  speed_kmh: number;
  lane: 1 | 2;
  at_stop_line: boolean;
  /** stopped while our signal is GREEN/NONE (i.e. it is the thing blocking us) */
  blocking: boolean;
  /** filled by the executor (stateful) */
  stopped_s: number;
  blocked_s: number;
  horns: number;
}

export interface LaneInfo {
  current: 0 | 1 | 2;
  target: 1 | 2;
  count: 2;
  alt: {
    index: 1 | 2;
    free_ahead_m: number;
    free_behind_m: number;
    behind_closing_kmh: number;
    ahead_kind: string | null;
    clear: boolean;
  };
  change_allowed: boolean;
  change_blocked_reason: string;
}

export interface SurroundObject {
  id: number;
  kind: string;
  dist_m: number;
  along_m: number;
  /** + = to our screen-left */
  lat_m: number;
  rel_heading_deg: number;
  speed_kmh: number;
  /** + = getting closer */
  closing_kmh: number;
  turning: boolean;
  in_box: boolean;
  oncoming: boolean;
}

export interface Surround {
  front: SurroundObject[];
  front_left: SurroundObject[];
  front_right: SurroundObject[];
  left: SurroundObject[];
  right: SurroundObject[];
  rear_left: SurroundObject[];
  rear_right: SurroundObject[];
  rear: SurroundObject[];
  oncoming: SurroundObject[];
  in_box: SurroundObject[];
}

export interface PedInfo {
  dist_m: number;
  along_m: number;
  lat_m: number;
  crossing: boolean;
  on_zebra: boolean;
  /** standing at the kerb, about to step out */
  waiting: boolean;
  /** near the zebra of the arm we intend to exit through */
  on_exit_zebra: boolean;
  sector: keyof Omit<Surround, "oncoming" | "in_box">;
}

export interface RouteJunction {
  id: string;
  x: number;
  z: number;
  dist_center_m: number;
  dist_stop_m: number;
  eta_s: number;
  in_box: boolean;
  can_left: boolean;
  can_right: boolean;
  can_straight: boolean;
  exit_heading: Partial<Record<Turn, "N" | "E" | "S" | "W">>;
  light: { color: SignalColor; seconds: number; color_at_eta: SignalColor } | null;
}

export interface DriveState {
  goal: {
    dist_m: number;
    bearing_deg: number;
    screen_side: "left" | "right" | "ahead";
    x: number;
    z: number;
    name: string;
    kind: string;
    short: string;
    in_area: boolean;
  };
  ego: {
    speed_kmh: number;
    length_m: number;
    gear: string;
    yaw_deg: number;
    fuel: number;
    on_road: boolean;
    x: number;
    z: number;
  };
  signal: {
    color: SignalColor;
    seconds: number;
    axis: "ns" | "ew" | "none";
    dist_to_stop_m: number;
    approaching: boolean;
    color_at_eta: SignalColor;
    eta_s: number;
  };
  lead: LeadInfo | null;
  lanes: LaneInfo;
  /** legacy compact lists (kept for Jev prompt compatibility) */
  ahead: Array<{ id: number; kind: string; dist_m: number; rel_speed_kmh: number; same_lane: boolean }>;
  cross: Array<{ kind: string; dist_m: number; crossing: boolean; eta_s: number }>;
  pedestrians: PedInfo[];
  junction: {
    dist_m: number;
    can_left: boolean;
    can_right: boolean;
    can_straight: boolean;
    plan: Turn;
  };
  route: {
    road: { axis: "x" | "z"; pos: number; dir: 1 | -1; heading: "N" | "E" | "S" | "W" };
    lane: { lat_err_m: number; heading_err_deg: number };
    next_junction: RouteJunction | null;
    after_next: { id: string; dist_center_m: number; can_left: boolean; can_right: boolean; can_straight: boolean } | null;
    plan: {
      next_turn: Turn;
      turn_after_next: Turn | "park" | null;
      costs: Partial<Record<Turn, number>>;
      reachable: boolean;
      goal_on_current_segment: boolean;
      goal_ahead_m: number | null;
    };
    /** seconds until the local executor must lock the turn for next_junction */
    lock_in_s: number;
  };
  surround: Surround;
  predicted: {
    horizon_s: number;
    speed_kmh: number;
    dist_stop_m: number | null;
    dist_center_m: number | null;
    signal_color: SignalColor;
  };
  rules: string;
}

/** Non-serialised geometry the executor needs (exits, frames) */
export interface RouteContext {
  frame: RoadFrame;
  junction: JunctionInfo | null;
  afterNext: JunctionInfo | null;
  exits: Partial<Record<Turn, ExitPose>>;
  lane: { lat: number; head: number };
}

/**
 * Screen-space bearing to goal (degrees). Positive = goal is to the LEFT of facing.
 */
export function screenBearingDeg(player: Vehicle, destX: number, destZ: number): number {
  const dx = destX - player.position.x;
  const dz = destZ - player.position.z;
  const worldBearing = Math.atan2(dx, dz);
  let rel = worldBearing - player.yaw;
  while (rel > Math.PI) rel -= Math.PI * 2;
  while (rel < -Math.PI) rel += Math.PI * 2;
  return (rel * 180) / Math.PI;
}

/**
 * Resolve which signal axis applies to the player (corridor first, yaw fallback).
 * Used by the HUD.
 */
export function approachSignalAxis(
  player: Vehicle,
  near: { light: { x: number; z: number }; dist: number; axis: "ns" | "ew" },
): { axis: "ns" | "ew"; approaching: boolean; arm: "n" | "s" | "e" | "w" } {
  const fwd = player.forward;
  const toLX = near.light.x - player.position.x;
  const toLZ = near.light.z - player.position.z;
  const approaching = toLX * fwd.x + toLZ * fwd.z > 0.25;
  const onNS = Math.abs(player.position.x - near.light.x) < ROAD_WIDTH * 0.7;
  const onEW = Math.abs(player.position.z - near.light.z) < ROAD_WIDTH * 0.7;
  let axis: "ns" | "ew" = near.axis;
  if (onNS && !onEW) axis = "ns";
  else if (onEW && !onNS) axis = "ew";
  else axis = Math.abs(fwd.x) < Math.abs(fwd.z) ? "ns" : "ew";
  const arm: "n" | "s" | "e" | "w" =
    axis === "ns"
      ? player.position.z < near.light.z
        ? "s"
        : "n"
      : player.position.x < near.light.x
        ? "w"
        : "e";
  return { axis, approaching, arm };
}

function sectorOf(along: number, lat: number): PedInfo["sector"] {
  const ang = (Math.atan2(lat, along) * 180) / Math.PI; // 0 = ahead, + = left
  const a = Math.abs(ang);
  if (a < 22.5) return "front";
  if (a < 67.5) return ang > 0 ? "front_left" : "front_right";
  if (a < 112.5) return ang > 0 ? "left" : "right";
  if (a < 157.5) return ang > 0 ? "rear_left" : "rear_right";
  return "rear";
}

/** Predict our signal colour `eta` seconds from now (approximate; ignores priority tweaks) */
function colorAtEta(color: SignalColor, seconds: number, eta: number): SignalColor {
  if (color === "NONE") return "NONE";
  if (eta <= seconds) return color;
  const over = eta - seconds;
  if (color === "GREEN") return over <= LIGHT_YELLOW ? "YELLOW" : "RED";
  if (color === "YELLOW") return "RED";
  // RED → eventually GREEN; red for us spans all-red + other green + other yellow + all-red (~18–30 s)
  return over > 0 ? "GREEN" : "RED";
}

export function buildDriveState(
  player: Vehicle,
  world: CityWorld,
  traffic: TrafficSystem,
  pedestrians: PedestrianSystem,
  onRoad: boolean,
  targetLane: 1 | 2 = 1,
): { state: DriveState; ctx: RouteContext } {
  const dest = world.destination;
  const place = world.destinationPlace;
  const px = player.position.x;
  const pz = player.position.z;
  const speed = Math.abs(player.speed);
  const dist = world.distToDestination(px, pz);
  const inArea = world.inDestination(px, pz);
  const bearing = screenBearingDeg(player, dest.x, dest.z);
  const screen_side = Math.abs(bearing) < 12 ? "ahead" : bearing > 0 ? "left" : "right";

  const fwd = player.forward;
  const leftVec = { x: fwd.z, z: -fwd.x }; // screen-left

  // ---- Route geometry ----
  const frame = currentRoadFrame(px, pz, player.yaw);
  const J = nextJunction(world, frame, px, pz);
  const g = goalRoad(dest.x, dest.z);
  const lane = laneErrors(frame, px, pz, player.yaw);
  const goalAhead = goalAheadOnSegment(frame, g, px, pz, J);

  let plan = { nextTurn: "straight" as Turn, turnAfterNext: null as Turn | "park" | null, costs: {} as Partial<Record<Turn, number>>, reachable: true };
  let afterNext: JunctionInfo | null = null;
  if (J && goalAhead === null) {
    plan = planAtJunction(world, J, frame.heading, g);
    const ex = J.exits[plan.nextTurn];
    if (ex) {
      const f2: RoadFrame = { axis: ex.axis, pos: ex.pos, dir: ex.dir, heading: ex.heading, yaw: ex.yaw };
      afterNext = nextJunction(world, f2, ex.x, ex.z, -1);
    }
  }

  const axisKey: "ns" | "ew" = frame.axis === "z" ? "ns" : "ew";
  const egoArm = approachArmFromTravel(frame.axis, frame.dir);
  let signal: DriveState["signal"] = {
    color: "NONE",
    seconds: 0,
    axis: "none",
    dist_to_stop_m: 999,
    approaching: false,
    color_at_eta: "NONE",
    eta_s: 99,
  };
  let routeJunction: RouteJunction | null = null;
  if (J) {
    const eta = J.distStop > 0 ? J.distStop / Math.max(speed, 0.6) : 0;
    let light: RouteJunction["light"] = null;
    if (J.light) {
      const color = world.signalForApproach(egoArm, J.light);
      const seconds = Math.max(0, Math.ceil(world.signalSecondsForApproach(egoArm, J.light)));
      light = { color, seconds, color_at_eta: colorAtEta(color, seconds, eta) };
      signal = {
        color,
        seconds,
        axis: axisKey,
        dist_to_stop_m: Math.round(J.distStop * 10) / 10,
        approaching: J.distCenter > 0,
        color_at_eta: light.color_at_eta,
        eta_s: Math.round(eta * 10) / 10,
      };
    } else {
      signal.dist_to_stop_m = Math.round(J.distStop * 10) / 10;
      signal.approaching = J.distCenter > 0;
      signal.eta_s = Math.round(eta * 10) / 10;
    }
    const exit_heading: RouteJunction["exit_heading"] = {};
    for (const t of ["left", "right", "straight"] as Turn[]) {
      const e = J.exits[t];
      if (e) exit_heading[t] = HEADING_NAME[e.heading];
    }
    routeJunction = {
      id: J.id,
      x: J.x,
      z: J.z,
      dist_center_m: Math.round(J.distCenter * 10) / 10,
      dist_stop_m: Math.round(J.distStop * 10) / 10,
      eta_s: Math.round(eta * 10) / 10,
      in_box: J.inBox,
      can_left: J.can.left,
      can_right: J.can.right,
      can_straight: J.can.straight,
      exit_heading,
      light,
    };
  }

  // ---- 360° surround ----
  const surround: Surround = {
    front: [],
    front_left: [],
    front_right: [],
    left: [],
    right: [],
    rear_left: [],
    rear_right: [],
    rear: [],
    oncoming: [],
    in_box: [],
  };
  const ahead: DriveState["ahead"] = [];
  const cross: DriveState["cross"] = [];

  // Lane bookkeeping on our own road (same direction only)
  const myLane = laneIndexAt(frame, px, pz);
  const altIndex: 1 | 2 = (myLane === 2 ? 1 : 2) as 1 | 2;
  let altAheadGap = 80;
  let altBehindGap = 80;
  let altBehindClosing = 0;
  let altAheadKind: string | null = null;
  let lead: LeadInfo | null = null;

  for (let idx = 0; idx < traffic.cars.length; idx++) {
    const ai = traffic.cars[idx];
    const o = ai.vehicle;

    // Same-road lane analysis (vehicles traveling our way on our road segment)
    if (!ai.turning) {
      const onRoadLat = frame.axis === "z" ? Math.abs(o.position.x - frame.pos) : Math.abs(o.position.z - frame.pos);
      const sameDir = Math.cos(Math.atan2(o.forward.x, o.forward.z) - frame.yaw) > 0.7;
      if (onRoadLat < ROAD_WIDTH / 2 + 0.5 && sameDir) {
        const oLane = laneIndexAt(frame, o.position.x, o.position.z);
        const along = alongOnFrame(frame, px, pz, o.position.x, o.position.z);
        const gap = Math.abs(along) - (o.length + player.length) / 2;
        if (oLane === (myLane || 1) && along > 0 && along < 45) {
          if (!lead || gap < lead.dist_m) {
            lead = {
              id: idx,
              kind: String(o.kind),
              dist_m: Math.round(Math.max(0, gap) * 10) / 10,
              speed_kmh: Math.round(Math.abs(o.speed) * 3.6),
              lane: oLane,
              at_stop_line: !!J && J.distStop - along < 4.5 && J.distStop - along > -4,
              blocking: false,
              stopped_s: 0,
              blocked_s: 0,
              horns: 0,
            };
          }
        } else if (oLane === altIndex) {
          if (along >= 0 && gap < altAheadGap) {
            altAheadGap = Math.max(0, gap);
            altAheadKind = String(o.kind);
          } else if (along < 0 && gap < altBehindGap) {
            altBehindGap = Math.max(0, gap);
            altBehindClosing = Math.round((Math.abs(o.speed) - speed) * 3.6);
          }
        }
      }
    }
    const dx = o.position.x - px;
    const dz = o.position.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > 70) continue;
    const along = dx * fwd.x + dz * fwd.z;
    const lat = dx * leftVec.x + dz * leftVec.z;
    const of = o.forward;
    const relHead = Math.atan2(of.x, of.z) - player.yaw;
    const relDeg = ((((relHead * 180) / Math.PI + 540) % 360) - 180);
    // closing speed along the line between us
    const ux = dx / (d || 1);
    const uz = dz / (d || 1);
    const ovx = of.x * o.speed;
    const ovz = of.z * o.speed;
    const pvx = fwd.x * player.speed;
    const pvz = fwd.z * player.speed;
    const closing = ((pvx - ovx) * ux + (pvz - ovz) * uz) * 3.6;
    const inBox = !!J && Math.abs(o.position.x - J.x) < ROAD_WIDTH / 2 + 1 && Math.abs(o.position.z - J.z) < ROAD_WIDTH / 2 + 1;
    const oncoming = Math.abs(relDeg) > 140 && along > 0 && Math.abs(lat) < ROAD_WIDTH * 0.9 && o.speed > 0.3;
    const headingWithUs = Math.abs(relDeg) < 55;

    // Same-turn / same-path cars in the box. Cross-street traffic (≈90°) is NOT our lead.
    if ((ai.turning || inBox) && headingWithUs && along > 0.2 && along < 28 && Math.abs(lat) < 4.2) {
      const bumper = along - (o.length + player.length) / 2;
      if (!lead || bumper < lead.dist_m) {
        lead = {
          id: idx,
          kind: String(o.kind),
          dist_m: Math.round(Math.max(0, bumper) * 10) / 10,
          speed_kmh: Math.round(Math.abs(o.speed) * 3.6),
          lane: (myLane || 1) as 1 | 2,
          at_stop_line: false,
          blocking: false,
          stopped_s: 0,
          blocked_s: 0,
          horns: 0,
        };
      }
    }

    const obj: SurroundObject = {
      id: idx,
      kind: String(o.kind),
      dist_m: Math.round(d * 10) / 10,
      along_m: Math.round(along * 10) / 10,
      lat_m: Math.round(lat * 10) / 10,
      rel_heading_deg: Math.round(relDeg),
      speed_kmh: Math.round(o.speed * 3.6),
      closing_kmh: Math.round(closing),
      turning: ai.turning,
      in_box: inBox,
      oncoming,
    };
    surround[sectorOf(along, lat)].push(obj);
    if (oncoming) surround.oncoming.push(obj);
    if (inBox) surround.in_box.push(obj);

    if (along > 0.4 && along < 55 && (Math.abs(lat) < 3.2 || (ai.turning && Math.abs(lat) < 5.8))) {
      ahead.push({
        id: idx,
        kind: obj.kind,
        dist_m: Math.round(along * 10) / 10,
        rel_speed_kmh: Math.round((o.speed - player.speed) * 3.6),
        same_lane: Math.abs(lat) < 2.2 || ai.turning,
      });
    } else if (d < 30 && Math.abs(lat) > 2.5 && along > -5 && along < 24 && Math.abs(relDeg) > 50 && Math.abs(relDeg) < 130) {
      cross.push({
        kind: obj.kind,
        dist_m: obj.dist_m,
        crossing: inBox || (Math.abs(along) < ROAD_WIDTH && d < ROAD_WIDTH * 1.2),
        eta_s: o.speed > 0.5 ? Math.round((d / o.speed) * 10) / 10 : 9,
      });
    }
  }
  for (const k of Object.keys(surround) as (keyof Surround)[]) {
    surround[k].sort((a, b) => a.dist_m - b.dist_m);
    surround[k] = surround[k].slice(0, 3);
  }
  ahead.sort((a, b) => a.dist_m - b.dist_m);
  cross.sort((a, b) => a.dist_m - b.dist_m);

  // Lane-change feasibility (geometry + gaps; the executor adds intent rules)
  const inBox = insideJunctionBox(px, pz, 1.5);
  const altClear =
    altAheadGap > 12 && (altBehindGap > 14 || (altBehindGap > 7 && altBehindClosing < 3));
  let changeReason = "";
  if (myLane === 0) changeReason = "on oncoming half";
  else if (inBox) changeReason = "inside junction box";
  else if (J && J.distStop < 6 && J.distStop > -1 && speed > 1.5) changeReason = "at stop line";
  else if (!altClear) changeReason = altAheadGap <= 12 ? `alt lane blocked ahead (${altAheadKind})` : "vehicle closing behind in alt lane";
  const lanes: LaneInfo = {
    current: myLane,
    target: targetLane,
    count: 2,
    alt: {
      index: altIndex,
      free_ahead_m: Math.round(altAheadGap * 10) / 10,
      free_behind_m: Math.round(altBehindGap * 10) / 10,
      behind_closing_kmh: altBehindClosing,
      ahead_kind: altAheadKind,
      clear: altClear,
    },
    change_allowed: changeReason === "",
    change_blocked_reason: changeReason,
  };

  // ---- Pedestrians (with exit-zebra awareness) ----
  const planExit = J?.exits[plan.nextTurn] ?? null;
  const exitZebra = J && planExit
    ? {
        x: J.x + (planExit.axis === "x" ? planExit.dir * (ROAD_WIDTH / 2 + 2.5) : 0),
        z: J.z + (planExit.axis === "z" ? planExit.dir * (ROAD_WIDTH / 2 + 2.5) : 0),
      }
    : null;
  const pedList: PedInfo[] = [];
  for (const ped of pedestrians.peds) {
    if (ped.mesh.userData.down) continue;
    const p = ped.mesh.position;
    const dx = p.x - px;
    const dz = p.z - pz;
    const d = Math.hypot(dx, dz);
    if (d > 42) continue;
    const along = dx * fwd.x + dz * fwd.z;
    const lat = dx * leftVec.x + dz * leftVec.z;
    const onExit = !!exitZebra && Math.hypot(p.x - exitZebra.x, p.z - exitZebra.z) < 7 && ped.mode === "cross";
    pedList.push({
      dist_m: Math.round(d * 10) / 10,
      along_m: Math.round(along * 10) / 10,
      lat_m: Math.round(lat * 10) / 10,
      crossing: ped.mode === "cross",
      waiting: ped.mode === "wait",
      on_zebra: pedestrians.isOnRoad(ped),
      on_exit_zebra: onExit,
      sector: sectorOf(along, lat),
    });
  }
  pedList.sort((a, b) => {
    const rank = (p: PedInfo) => {
      const onPath = p.crossing || p.on_zebra || p.on_exit_zebra;
      const waiterAhead = p.waiting && p.along_m > -4 && p.along_m < 28;
      const threat = onPath ? 0 : waiterAhead ? 1 : 2;
      const ahead = p.along_m > -3 ? 0 : 1;
      return threat * 1000 + ahead * 100 + p.dist_m;
    };
    return rank(a) - rank(b);
  });

  // ---- Predicted (latency horizon) ----
  const travel = speed * JEV_HORIZON_S;
  const predicted: DriveState["predicted"] = {
    horizon_s: JEV_HORIZON_S,
    speed_kmh: Math.round(speed * 3.6),
    dist_stop_m: J ? Math.round((J.distStop - travel) * 10) / 10 : null,
    dist_center_m: J ? Math.round((J.distCenter - travel) * 10) / 10 : null,
    signal_color: signal.color === "NONE" ? "NONE" : colorAtEta(signal.color, signal.seconds, JEV_HORIZON_S),
  };

  const lockDist = Math.max(12, speed * 2.0 + 6);
  const lockIn = J ? Math.max(0, (J.distStop - lockDist) / Math.max(speed, 0.8)) : 99;

  if (lead) {
    const clearing = !!J && (J.inBox || J.distStop < 2);
    const sigOk = signal.color === "GREEN" || signal.color === "NONE" || (J ? J.distStop > 30 : true);
    // Don't treat a slow car as "blocking" while we are already committed through the box,
    // or the next road's red would freeze us on the zebra.
    lead.blocking = !clearing && lead.speed_kmh < 3 && sigOk && lead.dist_m < 18;
  }

  const state: DriveState = {
    goal: {
      dist_m: Math.round(dist * 10) / 10,
      bearing_deg: Math.round(bearing * 10) / 10,
      screen_side,
      x: Math.round(dest.x * 10) / 10,
      z: Math.round(dest.z * 10) / 10,
      name: place?.name ?? "destination area",
      kind: place?.kind ?? "area",
      short: place?.short ?? "DEST",
      in_area: inArea,
    },
    ego: {
      speed_kmh: player.speedKmh(),
      length_m: Math.round(player.length * 10) / 10,
      gear: player.gear,
      yaw_deg: Math.round(((player.yaw * 180) / Math.PI) * 10) / 10,
      fuel: Math.round(player.fuel),
      on_road: onRoad,
      x: Math.round(px * 10) / 10,
      z: Math.round(pz * 10) / 10,
    },
    signal,
    lead,
    lanes,
    ahead: ahead.slice(0, 4),
    cross: cross.slice(0, 4),
    pedestrians: pedList.slice(0, 14),
    junction: {
      dist_m: J ? Math.round(J.distCenter * 10) / 10 : 999,
      can_left: J?.can.left ?? true,
      can_right: J?.can.right ?? true,
      can_straight: J?.can.straight ?? true,
      plan: plan.nextTurn,
    },
    route: {
      road: { axis: frame.axis, pos: frame.pos, dir: frame.dir, heading: HEADING_NAME[frame.heading] },
      lane: { lat_err_m: Math.round(lane.lat * 100) / 100, heading_err_deg: Math.round(((lane.head * 180) / Math.PI) * 10) / 10 },
      next_junction: routeJunction,
      after_next: afterNext
        ? {
            id: afterNext.id,
            dist_center_m: Math.round(((J?.distCenter ?? 0) + afterNext.distCenter) * 10) / 10,
            can_left: afterNext.can.left,
            can_right: afterNext.can.right,
            can_straight: afterNext.can.straight,
          }
        : null,
      plan: {
        next_turn: plan.nextTurn,
        turn_after_next: plan.turnAfterNext,
        costs: Object.fromEntries(
          Object.entries(plan.costs).map(([k, v]) => [k, Math.round(v as number)]),
        ) as Partial<Record<Turn, number>>,
        reachable: plan.reachable,
        goal_on_current_segment: goalAhead !== null,
        goal_ahead_m: goalAhead === null ? null : Math.round(goalAhead * 10) / 10,
      },
      lock_in_s: Math.round(lockIn * 10) / 10,
    },
    surround,
    predicted,
    rules:
      "India keep-left. Drive to the named destination area (goal.name). " +
      "Entering that block counts as arrived — it is not a tiny parking bay. " +
      "Pick the shortest remaining_m unless that exit is blocked.",
  };

  return {
    state,
    ctx: { frame, junction: J, afterNext, exits: J?.exits ?? {}, lane },
  };
}
