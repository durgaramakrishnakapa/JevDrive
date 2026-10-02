import { CITY_BLOCKS, LANE_WIDTH, ROAD_WIDTH, STOP_LINE_SETBACK } from "./constants";
import { coordX, coordZ, gapOn, getCityAxes, indexX, indexZ } from "./cityGrid";
import {
  keepLeftLateralSign,
  laneLateral,
  poseOnRoad,
  travelForward,
  travelLeft,
  yawForTravel,
  type TravelDir,
} from "./lanes";
import type { CityWorld, JunctionArms, LightState } from "./world";

/**
 * Grid route planning + path geometry for the autonomous driver.
 *
 * World: +X = east, +Z = north. yaw 0 = north, +π/2 = east.
 * Screen-left turn = yaw + π/2 (N→E→S→W), screen-right = yaw − π/2.
 */

export type Turn = "left" | "right" | "straight";
export type Heading = 0 | 1 | 2 | 3; // 0 N(+Z) 1 E(+X) 2 S(−Z) 3 W(−X)

export const HEADING_NAME: Record<Heading, "N" | "E" | "S" | "W"> = { 0: "N", 1: "E", 2: "S", 3: "W" };
const ARM_KEY: Record<Heading, keyof JunctionArms> = { 0: "n", 1: "e", 2: "s", 3: "w" };

export const STOP_LINE = STOP_LINE_SETBACK;
/** How far past the junction center the exit lane waypoint sits */
export const EXIT_CLEAR = ROAD_WIDTH / 2 + 5;

export const TURN_PENALTY: Record<Turn, number> = { straight: 0, left: 6, right: 14 };

export function wrapAngle(a: number): number {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
}

export function headingFromYaw(yaw: number): Heading {
  const q = Math.round(yaw / (Math.PI / 2));
  return (((q % 4) + 4) % 4) as Heading;
}

export function yawForHeading(h: Heading): number {
  return h === 0 ? 0 : h === 1 ? Math.PI / 2 : h === 2 ? Math.PI : -Math.PI / 2;
}

export function applyTurn(h: Heading, t: Turn): Heading {
  if (t === "left") return ((h + 1) % 4) as Heading;
  if (t === "right") return ((h + 3) % 4) as Heading;
  return h;
}

export function headingAxis(h: Heading): "x" | "z" {
  return h === 0 || h === 2 ? "z" : "x";
}

export function headingDir(h: Heading): TravelDir {
  return h === 0 || h === 1 ? 1 : -1;
}

function roadIndex(coord: number, axis: "x" | "z" = "x"): number {
  return axis === "x" ? indexX(coord) : indexZ(coord);
}

function indexCoord(i: number, axis: "x" | "z"): number {
  return axis === "x" ? coordX(i) : coordZ(i);
}

function inGrid(i: number, j: number): boolean {
  return i >= 0 && i <= CITY_BLOCKS && j >= 0 && j <= CITY_BLOCKS;
}

function stepIndex(i: number, j: number, h: Heading): { i: number; j: number } {
  if (h === 0) return { i, j: j + 1 };
  if (h === 1) return { i: i + 1, j };
  if (h === 2) return { i, j: j - 1 };
  return { i: i - 1, j };
}

function edgeLength(i: number, j: number, h: Heading): number {
  const { xs, zs } = getCityAxes();
  if (h === 0) return gapOn(zs, j);
  if (h === 2) return gapOn(zs, j - 1);
  if (h === 1) return gapOn(xs, i);
  return gapOn(xs, i - 1);
}

export interface RoadFrame {
  axis: "x" | "z";
  pos: number;
  dir: TravelDir;
  heading: Heading;
  yaw: number;
}

/** Snap the car onto its current road corridor */
export function currentRoadFrame(x: number, z: number, yaw: number): RoadFrame {
  const heading = headingFromYaw(yaw);
  const axis = headingAxis(heading);
  const dir = headingDir(heading);
  const lat = axis === "z" ? x : z;
  const idx = Math.max(0, Math.min(CITY_BLOCKS, roadIndex(lat, axis === "z" ? "x" : "z")));
  // axial road position: for NS travel (axis z) pos is X = index on xs
  const pos = axis === "z" ? indexCoord(idx, "x") : indexCoord(idx, "z");
  return { axis, pos, dir, heading, yaw: yawForHeading(heading) };
}

export interface LaneErrors {
  /** metres, + = lane centre is to our screen-LEFT */
  lat: number;
  /** radians, + = need to yaw left */
  head: number;
}

export type LaneIndex = 1 | 2;

/** Which keep-left lane a point sits in on this road frame (0 = oncoming half) */
export function laneIndexAt(frame: RoadFrame, x: number, z: number): 0 | LaneIndex {
  const sign = keepLeftLateralSign(frame.axis, frame.dir);
  const lat = frame.axis === "z" ? x : z;
  const off = (lat - frame.pos) * sign;
  if (off < -0.3) return 0;
  return off > LANE_WIDTH ? 2 : 1;
}

/** Signed along-road distance of a point from (x,z) in travel direction */
export function alongOnFrame(frame: RoadFrame, x: number, z: number, ox: number, oz: number): number {
  return frame.axis === "z" ? (oz - z) * frame.dir : (ox - x) * frame.dir;
}

export function laneErrors(frame: RoadFrame, x: number, z: number, yaw: number, lane: LaneIndex = 1): LaneErrors {
  const target = laneLateral(frame.axis, frame.pos, frame.dir, lane);
  const L = travelLeft(frame.axis, frame.dir);
  const dx = frame.axis === "z" ? target - x : 0;
  const dz = frame.axis === "x" ? target - z : 0;
  const lat = dx * L.x + dz * L.z;
  const head = wrapAngle(yawForTravel(frame.axis, frame.dir) - yaw);
  return { lat, head };
}

export interface ExitPose {
  x: number;
  z: number;
  yaw: number;
  axis: "x" | "z";
  pos: number;
  dir: TravelDir;
  heading: Heading;
}

export interface JunctionInfo {
  id: string;
  i: number;
  j: number;
  x: number;
  z: number;
  arms: JunctionArms;
  /** signed metres along travel to centre (negative = behind us) */
  distCenter: number;
  distStop: number;
  inBox: boolean;
  can: Record<Turn, boolean>;
  exits: Partial<Record<Turn, ExitPose>>;
  light: LightState | null;
}

/** Edge traversable only if both facing arms are open (closed arm = sidewalk cap) */
function edgeOpen(world: CityWorld, i: number, j: number, h: Heading): boolean {
  const a = world.junctionAt(indexCoord(i, "x"), indexCoord(j, "z"));
  if (!a || !a.arms[ARM_KEY[h]]) return false;
  const n = stepIndex(i, j, h);
  if (!inGrid(n.i, n.j)) return false;
  const b = world.junctionAt(indexCoord(n.i, "x"), indexCoord(n.j, "z"));
  const back = ((h + 2) % 4) as Heading;
  return !!b && b.arms[ARM_KEY[back]];
}

export function exitPoseFor(jx: number, jz: number, h: Heading): ExitPose {
  const axis = headingAxis(h);
  const dir = headingDir(h);
  const pos = axis === "z" ? jx : jz;
  const centerAlong = axis === "z" ? jz : jx;
  const p = poseOnRoad(axis, pos, centerAlong + dir * EXIT_CLEAR, dir, 1);
  return { x: p.x, z: p.z, yaw: p.yaw, axis, pos, dir, heading: h };
}

/** First junction ahead on the frame's road (keeps the current one while inside its box) */
export function nextJunction(
  world: CityWorld,
  frame: RoadFrame,
  x: number,
  z: number,
  _keepBehind = ROAD_WIDTH / 2 + 1,
): JunctionInfo | null {
  const along = frame.axis === "z" ? z : x;
  const kStart = roadIndex(along, frame.axis === "z" ? "z" : "x");
  // Scan a few junction indices in travel direction (and one behind for in-box)
  for (let s = -1; s <= CITY_BLOCKS + 1; s++) {
    const k = kStart + s * frame.dir;
    if (k < 0 || k > CITY_BLOCKS) continue;
    const centerAlong = indexCoord(k, frame.axis === "z" ? "z" : "x");
    const distCenter = (centerAlong - along) * frame.dir;
    // Once past the junction centre, this light is behind us — look at the next one.
    // Stopping here is what makes Auto freeze while crossing into the other road.
    if (distCenter < -1.2) continue;
    const i = frame.axis === "z" ? roadIndex(frame.pos, "x") : k;
    const j = frame.axis === "z" ? k : roadIndex(frame.pos, "z");
    if (!inGrid(i, j)) continue;
    const jx = indexCoord(i, "x");
    const jz = indexCoord(j, "z");
    const rec = world.junctionAt(jx, jz);
    const arms: JunctionArms = rec?.arms ?? { n: true, s: true, e: true, w: true };
    const can: Record<Turn, boolean> = {
      straight: edgeOpen(world, i, j, applyTurn(frame.heading, "straight")),
      left: edgeOpen(world, i, j, applyTurn(frame.heading, "left")),
      right: edgeOpen(world, i, j, applyTurn(frame.heading, "right")),
    };
    const exits: Partial<Record<Turn, ExitPose>> = {};
    for (const t of ["left", "right", "straight"] as Turn[]) {
      if (can[t]) exits[t] = exitPoseFor(jx, jz, applyTurn(frame.heading, t));
    }
    const light = world.lights.find((L) => Math.abs(L.x - jx) < 1 && Math.abs(L.z - jz) < 1) ?? null;
    return {
      id: `${i},${j}`,
      i,
      j,
      x: jx,
      z: jz,
      arms,
      distCenter,
      distStop: distCenter - STOP_LINE,
      inBox: Math.abs(distCenter) < ROAD_WIDTH / 2 + 0.5,
      can,
      exits,
      light,
    };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Goal / route planning                                               */
/* ------------------------------------------------------------------ */

export interface GoalRoad {
  axis: "x" | "z";
  pos: number;
  along: number;
  /** junction indices bounding the segment along the road axis */
  kLo: number;
  kHi: number;
}

export function goalRoad(gx: number, gz: number): GoalRoad {
  // Prefer the horizontal (x) road if the goal sits on one, else vertical
  const zi = indexZ(gz);
  const xi = indexX(gx);
  const onX = Math.abs(gz - coordZ(zi)) <= ROAD_WIDTH / 2 + 0.5;
  if (onX) {
    // Find segment along xs that contains gx
    const { xs } = getCityAxes();
    let kLo = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      if (gx >= Math.min(xs[i], xs[i + 1]) - 0.5 && gx <= Math.max(xs[i], xs[i + 1]) + 0.5) {
        kLo = i;
        break;
      }
      if (i === xs.length - 2) kLo = Math.max(0, xs.length - 2);
    }
    return { axis: "x", pos: coordZ(zi), along: gx, kLo, kHi: kLo + 1 };
  }
  const { zs } = getCityAxes();
  let kLo = 0;
  for (let i = 0; i < zs.length - 1; i++) {
    if (gz >= Math.min(zs[i], zs[i + 1]) - 0.5 && gz <= Math.max(zs[i], zs[i + 1]) + 0.5) {
      kLo = i;
      break;
    }
    if (i === zs.length - 2) kLo = Math.max(0, zs.length - 2);
  }
  return { axis: "z", pos: coordX(xi), along: gz, kLo, kHi: kLo + 1 };
}

/** Does the directed edge from junction (i,j) heading h contain the goal? */
function edgeIsGoal(g: GoalRoad, i: number, j: number, h: Heading): boolean {
  const axis = headingAxis(h);
  if (axis !== g.axis) return false;
  const pos = axis === "z" ? indexCoord(i, "x") : indexCoord(j, "z");
  if (Math.abs(pos - g.pos) > 1) return false;
  const k = axis === "z" ? j : i;
  const n = stepIndex(i, j, h);
  const k2 = axis === "z" ? n.j : n.i;
  const lo = Math.min(k, k2);
  const hi = Math.max(k, k2);
  return g.kLo >= lo && g.kHi <= hi;
}

interface RouteResult {
  cost: number;
  firstMove: Turn | "park" | null;
}

const routeCache = new Map<string, RouteResult>();

/** Dijkstra over (junction, heading) states. No U-turns. */
function routeFrom(world: CityWorld, g: GoalRoad, i0: number, j0: number, h0: Heading): RouteResult {
  const key = `${i0},${j0},${h0},${g.axis},${g.pos},${g.along.toFixed(1)}`;
  const cached = routeCache.get(key);
  if (cached) return cached;

  const N = (CITY_BLOCKS + 1) * (CITY_BLOCKS + 1) * 4;
  const idx = (i: number, j: number, h: number) => ((i * (CITY_BLOCKS + 1) + j) * 4 + h);
  const dist = new Float64Array(N).fill(Infinity);
  const prevMove: (Turn | null)[] = new Array(N).fill(null);
  const prevState = new Int32Array(N).fill(-1);
  const done = new Uint8Array(N);

  const start = idx(i0, j0, h0);
  dist[start] = 0;
  let bestGoal = Infinity;
  let bestGoalState = -1;
  let bestGoalMove: Turn | null = null;

  for (let iter = 0; iter < N; iter++) {
    let u = -1;
    let best = Infinity;
    for (let s = 0; s < N; s++) {
      if (!done[s] && dist[s] < best) {
        best = dist[s];
        u = s;
      }
    }
    if (u < 0 || best >= bestGoal) break;
    done[u] = 1;
    const h = (u % 4) as Heading;
    const ij = Math.floor(u / 4);
    const i = Math.floor(ij / (CITY_BLOCKS + 1));
    const j = ij % (CITY_BLOCKS + 1);

    for (const t of ["straight", "left", "right"] as Turn[]) {
      const h2 = applyTurn(h, t);
      if (!edgeOpen(world, i, j, h2)) continue;
      const pen = TURN_PENALTY[t];
      if (edgeIsGoal(g, i, j, h2)) {
        const along = headingAxis(h2) === "z" ? indexCoord(j, "z") : indexCoord(i, "x");
        const c = dist[u] + pen + Math.abs(g.along - along);
        if (c < bestGoal) {
          bestGoal = c;
          bestGoalState = u;
          bestGoalMove = t;
        }
        continue;
      }
      const n = stepIndex(i, j, h2);
      const v = idx(n.i, n.j, h2);
      const c = dist[u] + pen + edgeLength(i, j, h2);
      if (c < dist[v]) {
        dist[v] = c;
        prevMove[v] = t;
        prevState[v] = u;
      }
    }
  }

  let result: RouteResult;
  if (bestGoalState < 0) {
    result = { cost: Infinity, firstMove: null };
  } else if (bestGoalState === start) {
    result = { cost: bestGoal, firstMove: bestGoalMove };
  } else {
    // Walk back to the first move out of the start state
    let s = bestGoalState;
    let move: Turn | null = prevMove[s];
    while (prevState[s] !== start && prevState[s] >= 0) {
      s = prevState[s];
      move = prevMove[s];
    }
    result = { cost: bestGoal, firstMove: move };
  }
  routeCache.set(key, result);
  return result;
}

export interface TurnPlan {
  nextTurn: Turn;
  turnAfterNext: Turn | "park" | null;
  costs: Partial<Record<Turn, number>>;
  reachable: boolean;
}

/** Cost-aware plan at a junction for every open option, plus the move after it */
export function planAtJunction(world: CityWorld, J: JunctionInfo, heading: Heading, g: GoalRoad): TurnPlan {
  const costs: Partial<Record<Turn, number>> = {};
  const after: Partial<Record<Turn, Turn | "park" | null>> = {};
  for (const t of ["straight", "left", "right"] as Turn[]) {
    if (!J.can[t]) continue;
    const h2 = applyTurn(heading, t);
    if (edgeIsGoal(g, J.i, J.j, h2)) {
      const along = headingAxis(h2) === "z" ? J.z : J.x;
      costs[t] = TURN_PENALTY[t] + Math.abs(g.along - along);
      after[t] = "park";
      continue;
    }
    const n = stepIndex(J.i, J.j, h2);
    const r = routeFrom(world, g, n.i, n.j, h2);
    costs[t] = TURN_PENALTY[t] + edgeLength(J.i, J.j, h2) + r.cost;
    after[t] = r.firstMove;
  }
  let best: Turn | null = null;
  let bestC = Infinity;
  for (const t of ["straight", "left", "right"] as Turn[]) {
    const c = costs[t];
    if (c !== undefined && c < bestC - 1e-6) {
      bestC = c;
      best = t;
    }
  }
  if (!best) {
    // Dead end: pick any open arm
    best = (["straight", "left", "right"] as Turn[]).find((t) => J.can[t]) ?? "straight";
    return { nextTurn: best, turnAfterNext: null, costs, reachable: false };
  }
  return { nextTurn: best, turnAfterNext: after[best] ?? null, costs, reachable: Number.isFinite(bestC) };
}

/** Is the goal on our current segment, ahead of us and before the next junction? */
export function goalAheadOnSegment(
  frame: RoadFrame,
  g: GoalRoad,
  x: number,
  z: number,
  J: JunctionInfo | null,
): number | null {
  if (frame.axis !== g.axis || Math.abs(frame.pos - g.pos) > 1) return null;
  const along = frame.axis === "z" ? z : x;
  const ahead = (g.along - along) * frame.dir;
  if (ahead < -6) return null;
  if (J && ahead > J.distCenter + ROAD_WIDTH / 2) return null;
  return ahead;
}

/* ------------------------------------------------------------------ */
/* Turn path (cubic Bezier like the AI cars) + pure pursuit            */
/* ------------------------------------------------------------------ */

export interface TurnPath {
  pts: { x: number; z: number }[];
  cum: number[];
  length: number;
  exit: ExitPose;
  turn: Turn;
}

export function buildTurnPath(
  start: { x: number; z: number; yaw: number },
  exit: ExitPose,
  turn: Turn,
): TurnPath {
  const left = turn === "left";
  const fwd = travelForward(headingAxis(headingFromYaw(start.yaw)), headingDir(headingFromYaw(start.yaw)));
  const entry = left ? 1.6 : 1.0;
  const p0 = { x: start.x + fwd.x * entry, z: start.z + fwd.z * entry };
  const p3 = { x: exit.x, z: exit.z };
  // Tangent-continuous cubic: handles along entry and exit directions, sized like a
  // circular-arc approximation (≈0.55 × leg) so yaw is aligned when we reach the exit lane.
  const exitFwd = travelForward(exit.axis, exit.dir);
  const corner =
    Math.abs(fwd.x) > 0.5
      ? { x: p3.x, z: p0.z } // entering along X, exiting along Z
      : { x: p0.x, z: p3.z }; // entering along Z, exiting along X
  const a = Math.hypot(corner.x - p0.x, corner.z - p0.z);
  const b = Math.hypot(p3.x - corner.x, p3.z - corner.z);
  const k = turn === "straight" ? 0.33 : 0.55;
  const p1 = { x: p0.x + fwd.x * a * k, z: p0.z + fwd.z * a * k };
  const p2 = { x: p3.x - exitFwd.x * b * k, z: p3.z - exitFwd.z * b * k };

  const N = 48;
  const pts: { x: number; z: number }[] = [];
  const cum: number[] = [];
  let acc = 0;
  for (let k = 0; k <= N; k++) {
    const s = k / N;
    const u = 1 - s;
    const x = u * u * u * p0.x + 3 * u * u * s * p1.x + 3 * u * s * s * p2.x + s * s * s * p3.x;
    const z = u * u * u * p0.z + 3 * u * u * s * p1.z + 3 * u * s * s * p2.z + s * s * s * p3.z;
    if (k > 0) acc += Math.hypot(x - pts[k - 1].x, z - pts[k - 1].z);
    pts.push({ x, z });
    cum.push(acc);
  }
  return { pts, cum, length: acc, exit, turn };
}

export interface PursuitResult {
  /** −1..1, + = screen-left */
  steer: number;
  /** 0..1 fraction of path completed */
  progress: number;
  /** radians heading error vs exit yaw */
  exitHeadErr: number;
  /** metres from car to path end */
  remaining: number;
}

export function purePursuit(path: TurnPath, x: number, z: number, yaw: number, lookahead: number): PursuitResult {
  let bestI = 0;
  let bestD = Infinity;
  for (let i = 0; i < path.pts.length; i++) {
    const d = Math.hypot(path.pts[i].x - x, path.pts[i].z - z);
    if (d < bestD) {
      bestD = d;
      bestI = i;
    }
  }
  const sNear = path.cum[bestI];
  let li = bestI;
  while (li < path.pts.length - 1 && path.cum[li] - sNear < lookahead) li++;
  const target = path.pts[li];
  const alpha = wrapAngle(Math.atan2(target.x - x, target.z - z) - yaw);
  // pure pursuit curvature → normalised steer (saturates ~0.42 rad)
  const steer = Math.max(-1, Math.min(1, alpha / 0.42));
  const progress = path.length > 0 ? sNear / path.length : 1;
  const exitHeadErr = wrapAngle(path.exit.yaw - yaw);
  const remaining = Math.hypot(path.pts[path.pts.length - 1].x - x, path.pts[path.pts.length - 1].z - z);
  return { steer, progress, exitHeadErr, remaining };
}

/** Lane-keeping steer (Stanley-ish): heading term + speed-scaled lateral term */
export function laneHoldSteer(err: LaneErrors, speedMps: number): number {
  const latGain = speedMps > 9 ? 0.26 : speedMps > 4 ? 0.36 : 0.5;
  const lat = Math.max(-0.55, Math.min(0.55, err.lat * latGain));
  const cmd = err.head * 1.9 + lat;
  return Math.max(-1, Math.min(1, cmd));
}

/** Is a world point inside any junction box (for keep-left suppression)? */
export function insideJunctionBox(x: number, z: number, margin = 2.5): boolean {
  const i = indexX(x);
  const j = indexZ(z);
  if (!inGrid(i, j)) return false;
  const dx = Math.abs(x - coordX(i));
  const dz = Math.abs(z - coordZ(j));
  return dx < ROAD_WIDTH / 2 + margin && dz < ROAD_WIDTH / 2 + margin;
}

export function clearRouteCache() {
  routeCache.clear();
}
