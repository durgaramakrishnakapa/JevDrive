import { ROAD_WIDTH } from "./constants";

/**
 * Named city districts. Jev routes to a whole block (Market, Hospital, …),
 * not a tiny parking bay — arriving anywhere in that block counts as done.
 */
export type PlaceKind =
  | "market"
  | "shopping"
  | "hospital"
  | "station"
  | "temple"
  | "college"
  | "stadium"
  | "itpark";

export interface PlaceDef {
  kind: PlaceKind;
  name: string;
  short: string;
  hint: string;
  color: number;
  accent: number;
}

export const PLACE_SEP_M = 100;

/** Hospital is never the mission. Market and Station show up more often. */
export function missionWeight(kind: PlaceKind): number {
  if (kind === "hospital") return 0;
  if (kind === "market" || kind === "station") return 3;
  return 1;
}

export function pickWeighted<T>(items: T[], weight: (item: T) => number): T {
  if (!items.length) throw new Error("pickWeighted: empty");
  const ws = items.map((it) => Math.max(0, weight(it)));
  const total = ws.reduce((s, w) => s + w, 0);
  if (total <= 0) return items[Math.floor(Math.random() * items.length)];
  let r = Math.random() * total;
  for (let i = 0; i < items.length; i++) {
    r -= ws[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export const PLACE_CATALOG: PlaceDef[] = [
  { kind: "market", name: "Market Area", short: "MARKET", hint: "open bazaar block", color: 0xc45c28, accent: 0xffc107 },
  { kind: "shopping", name: "Shopping Complex", short: "SHOPPING", hint: "mall and shops", color: 0x3d6fd9, accent: 0x90caf9 },
  { kind: "hospital", name: "Hospital Campus", short: "HOSPITAL", hint: "medical campus", color: 0xe8eef4, accent: 0xe53935 },
  { kind: "station", name: "Railway Station", short: "STATION", hint: "rail terminus", color: 0x6a5344, accent: 0xffb300 },
  { kind: "temple", name: "Temple Grounds", short: "TEMPLE", hint: "temple precinct", color: 0xc99212, accent: 0xfff3c4 },
  { kind: "college", name: "College Campus", short: "COLLEGE", hint: "university block", color: 0x2f6a48, accent: 0xa5d6a7 },
  { kind: "stadium", name: "Sports Stadium", short: "STADIUM", hint: "arena block", color: 0x1e6b3a, accent: 0x81c784 },
  { kind: "itpark", name: "IT Park", short: "IT PARK", hint: "tech campus", color: 0x31415f, accent: 0x80deea },
];

export interface CityPlace extends PlaceDef {
  bx: number;
  bz: number;
  /** Road-line bounds of the cell */
  x0: number;
  x1: number;
  z0: number;
  z1: number;
  /** Arrival box — the block plus its four bounding roads */
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  cx: number;
  cz: number;
  /** Keep-left gate on a bounding road — used by the route planner */
  gateX: number;
  gateZ: number;
}

export function shuffleInPlace<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export function inPlace(p: CityPlace, x: number, z: number): boolean {
  return x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ;
}

/** Distance to the area edge (0 once you have entered the block). */
export function distToPlace(p: CityPlace, x: number, z: number): number {
  if (inPlace(p, x, z)) return 0;
  const dx = x < p.minX ? p.minX - x : x > p.maxX ? x - p.maxX : 0;
  const dz = z < p.minZ ? p.minZ - z : z > p.maxZ ? z - p.maxZ : 0;
  return Math.hypot(dx, dz);
}

export function makeCityPlace(
  def: PlaceDef,
  bx: number,
  bz: number,
  x0: number,
  x1: number,
  z0: number,
  z1: number,
  spawnX: number,
  spawnZ: number,
): CityPlace {
  const half = ROAD_WIDTH / 2;
  const cx = (x0 + x1) / 2;
  const cz = (z0 + z1) / 2;
  const gates = [
    { x: cx, z: z0 },
    { x: cx, z: z1 },
    { x: x0, z: cz },
    { x: x1, z: cz },
  ];
  let gate = gates[0];
  let best = Infinity;
  for (const g of gates) {
    const d = Math.hypot(g.x - spawnX, g.z - spawnZ);
    if (d < best) {
      best = d;
      gate = g;
    }
  }
  return {
    ...def,
    bx,
    bz,
    x0,
    x1,
    z0,
    z1,
    minX: x0 - half,
    maxX: x1 + half,
    minZ: z0 - half,
    maxZ: z1 + half,
    cx,
    cz,
    gateX: gate.x,
    gateZ: gate.z,
  };
}
