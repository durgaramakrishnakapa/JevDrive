import { LANE_WIDTH } from "./constants";

/**
 * Indian keep-left as seen from the chase camera (screen space).
 *
 * World: +X = east, +Z = north.
 *
 * Three.js PerspectiveCamera.lookAt maps screen-left to cross(+Y, forward):
 *   facing +Z → screen-left = +X
 *   facing −Z → screen-left = −X
 *   facing +X → screen-left = −Z
 *   facing −X → screen-left = +Z
 *
 * (Geographic “driver’s left” is the opposite of screen-left with this camera,
 * which is why earlier placements looked like US keep-right on screen.)
 *
 * India LHT on screen: drive LEFT of yellow; oncoming on the RIGHT.
 */

export type RoadAxis = "x" | "z";

/** +1 = increasing world coordinate along the road axis */
export type TravelDir = 1 | -1;

/** Unit forward on the road axis for a travel direction */
export function travelForward(roadAxis: RoadAxis, travelDir: TravelDir): { x: number; z: number } {
  if (roadAxis === "z") return { x: 0, z: travelDir };
  return { x: travelDir, z: 0 };
}

/**
 * Unit screen-left of travel for the chase camera = cross(+Y, forward).
 * Place keep-left traffic along this direction from the yellow line.
 */
export function travelLeft(roadAxis: RoadAxis, travelDir: TravelDir): { x: number; z: number } {
  const f = travelForward(roadAxis, travelDir);
  return { x: f.z, z: -f.x };
}

/**
 * Sign on the lateral world axis (X for z-roads, Z for x-roads) for keep-left.
 */
export function keepLeftLateralSign(roadAxis: RoadAxis, travelDir: TravelDir): number {
  const L = travelLeft(roadAxis, travelDir);
  return roadAxis === "z" ? Math.sign(L.x) || 1 : Math.sign(L.z) || -1;
}

/** Yaw (radians) for traveling along a road in travelDir */
export function yawForTravel(roadAxis: RoadAxis, travelDir: TravelDir): number {
  if (roadAxis === "z") return travelDir > 0 ? 0 : Math.PI;
  return travelDir > 0 ? Math.PI / 2 : -Math.PI / 2;
}

/**
 * World lateral coordinate (x for z-roads, z for x-roads) for an Indian keep-left lane.
 * @param laneIndex 1 = nearer center, 2 = nearer curb
 */
export function laneLateral(
  roadAxis: RoadAxis,
  roadPos: number,
  travelDir: TravelDir,
  laneIndex: 1 | 2 = 1,
): number {
  const mag = LANE_WIDTH * (laneIndex - 0.5);
  return roadPos + keepLeftLateralSign(roadAxis, travelDir) * mag;
}

/** Full pose on a road */
export function poseOnRoad(
  roadAxis: RoadAxis,
  roadPos: number,
  along: number,
  travelDir: TravelDir,
  laneIndex: 1 | 2 = 1,
): { x: number; z: number; yaw: number } {
  const lat = laneLateral(roadAxis, roadPos, travelDir, laneIndex);
  const yaw = yawForTravel(roadAxis, travelDir);
  if (roadAxis === "z") return { x: lat, z: along, yaw };
  return { x: along, z: lat, yaw };
}

/**
 * Legacy signed-lane helper: lane > 0 → travelDir +1, |lane| is lane index.
 * Kept so call sites migrate cleanly.
 */
export function laneCenter(roadAxis: RoadAxis, roadPos: number, lane: number): number {
  const travelDir = (Math.sign(lane) || 1) as TravelDir;
  const laneIndex = (Math.abs(lane) >= 2 ? 2 : 1) as 1 | 2;
  return laneLateral(roadAxis, roadPos, travelDir, laneIndex);
}

export function travelDirFromLane(lane: number): TravelDir {
  return (Math.sign(lane) || 1) as TravelDir;
}

export function laneIndexFromLane(lane: number): 1 | 2 {
  return Math.abs(lane) >= 2 ? 2 : 1;
}

/** Encode travelDir + laneIndex back to signed lane used by AICar */
export function toSignedLane(travelDir: TravelDir, laneIndex: 1 | 2): number {
  return travelDir * laneIndex;
}
