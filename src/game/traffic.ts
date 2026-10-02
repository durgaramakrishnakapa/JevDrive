import * as THREE from "three";
import {
  BLOCK,
  CAR_COLORS,
  ROAD_WIDTH,
  STOP_LINE_SETBACK,
  TRAFFIC_COUNT,
  TRAFFIC_MIN_GAP,
} from "./constants";
import { cityHalfSpan, cityMaxX, cityMaxZ, cityMinX, cityMinZ, getCityAxes } from "./cityGrid";
import {
  AUTO_COLORS,
  isHeavyVehicle,
  LORRY_COLORS,
  randomTrafficKind,
  setVehicleSignals,
  spinWheels,
  SCHOOL_BUS_YELLOW,
  type VehicleKind,
} from "./carMesh";
import {
  laneIndexFromLane,
  laneLateral,
  poseOnRoad,
  toSignedLane,
  travelDirFromLane,
  yawForTravel,
  type TravelDir,
} from "./lanes";
import { Vehicle, aabbHit, type DriveInput } from "./vehicle";
import type { CityWorld, JunctionArms } from "./world";
import { approachArmFromTravel } from "./world";
import type { PedestrianSystem } from "./pedestrians";

export { laneCenter } from "./lanes";

type TurnIntent = "straight" | "left" | "right";

interface TurnSample {
  x: number;
  z: number;
  yaw: number;
  s: number;
}

/** Tangent-continuous cubic Bezier through the junction. Left (near-side) is tighter; right sweeps the box. */
function sampleTurnPath(
  p0: { x: number; z: number; yaw: number },
  p3: { x: number; z: number; yaw: number },
  left: boolean,
  n = 56,
): TurnSample[] {
  const f0 = { x: Math.sin(p0.yaw), z: Math.cos(p0.yaw) };
  const f3 = { x: Math.sin(p3.yaw), z: Math.cos(p3.yaw) };
  const corner = Math.abs(f0.x) > 0.5 ? { x: p3.x, z: p0.z } : { x: p0.x, z: p3.z };
  const a = Math.hypot(corner.x - p0.x, corner.z - p0.z);
  const b = Math.hypot(p3.x - corner.x, p3.z - corner.z);
  // Near-side (left) hugs the kerb; far-side (right) takes a wider line through the box
  const kIn = left ? 0.38 : 0.58;
  const kOut = left ? 0.42 : 0.64;
  const c1 = { x: p0.x + f0.x * a * kIn, z: p0.z + f0.z * a * kIn };
  const c2 = { x: p3.x - f3.x * b * kOut, z: p3.z - f3.z * b * kOut };
  const out: TurnSample[] = [];
  let s = 0;
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x;
    const z = u * u * u * p0.z + 3 * u * u * t * c1.z + 3 * u * t * t * c2.z + t * t * t * p3.z;
    const tx = 3 * u * u * (c1.x - p0.x) + 6 * u * t * (c2.x - c1.x) + 3 * t * t * (p3.x - c2.x);
    const tz = 3 * u * u * (c1.z - p0.z) + 6 * u * t * (c2.z - c1.z) + 3 * t * t * (p3.z - c2.z);
    const yaw = tx * tx + tz * tz > 1e-6 ? Math.atan2(tx, tz) : i === 0 ? p0.yaw : out[i - 1].yaw;
    if (i > 0) s += Math.hypot(x - out[i - 1].x, z - out[i - 1].z);
    out.push({ x, z, yaw, s });
  }
  return out;
}

interface AICar {
  vehicle: Vehicle;
  roadAxis: "x" | "z";
  roadPos: number;
  lane: number;
  targetSpeed: number;
  /** Chosen maneuver for the upcoming / current junction */
  intent: TurnIntent;
  blinker: "none" | "left" | "right";
  /** Junction key we already decided for */
  decidedJx: number | null;
  decidedJz: number | null;
  /** Animated turn through the box (arc-length driven, tangent-continuous) */
  turning: boolean;
  /** Sampled path: position, heading and cumulative distance */
  turnPath: TurnSample[];
  /** Distance travelled along turnPath */
  turnS: number;
  turnLen: number;
  turnEnd: { x: number; z: number; yaw: number };
  turnNext: { roadAxis: "x" | "z"; roadPos: number; lane: number };
  /** Seconds we've been held mid-turn by a conflict (watchdog) */
  turnHeld: number;
  /** Human-like hesitation before pulling away on green (seconds left) */
  reactTimer: number;
  /** Was held at the stop line on red/yellow last frame */
  heldAtLine: boolean;
  /** Continuous seconds at (near) standstill */
  stoppedFor: number;
  /** Until this traffic-time, the driver was honked at: no hesitation, go if physically clear */
  hornedUntil: number;
}

export class TrafficSystem {
  cars: AICar[] = [];
  private scene: THREE.Scene;
  private world: CityWorld;

  constructor(world: CityWorld, scene: THREE.Scene) {
    this.world = world;
    this.scene = scene;
    this.spawnAll();
  }

  private spawnAll() {
    const forced: { kind: VehicleKind; color: number }[] = [
      { kind: "schoolBus", color: SCHOOL_BUS_YELLOW },
      { kind: "schoolBus", color: SCHOOL_BUS_YELLOW },
      { kind: "truck", color: 0xef6c00 },
      { kind: "truck", color: 0x37474f },
      { kind: "lorry", color: 0xd84315 },
      { kind: "lorry", color: 0x1565c0 },
      { kind: "auto", color: 0xf9c500 },
      { kind: "auto", color: 0xf9c500 },
      { kind: "auto", color: 0x2e7d32 },
      { kind: "auto", color: 0xffd54f },
      { kind: "auto", color: 0x1b5e20 },
    ];
    for (const f of forced) {
      let tries = 0;
      while (tries++ < 40) {
        if (this.spawnOne(f.kind, f.color)) break;
      }
    }
    let attempts = 0;
    while (this.cars.length < TRAFFIC_COUNT && attempts < TRAFFIC_COUNT * 40) {
      attempts++;
      this.spawnOne();
    }
  }

  private laneOccupied(roadAxis: "x" | "z", roadPos: number, lane: number, along: number): boolean {
    for (const c of this.cars) {
      if (c.turning) continue;
      if (c.roadAxis !== roadAxis || c.roadPos !== roadPos || c.lane !== lane) continue;
      const otherAlong = roadAxis === "z" ? c.vehicle.position.z : c.vehicle.position.x;
      // long vehicles need more room than the nominal gap
      if (Math.abs(otherAlong - along) < TRAFFIC_MIN_GAP + c.vehicle.length * 0.5) return true;
    }
    return false;
  }

  private freshAI(partial: Omit<AICar, "intent" | "blinker" | "decidedJx" | "decidedJz" | "turning" | "turnPath" | "turnS" | "turnLen" | "turnEnd" | "turnNext" | "turnHeld" | "reactTimer" | "heldAtLine" | "stoppedFor" | "hornedUntil">): AICar {
    return {
      ...partial,
      reactTimer: 0,
      heldAtLine: false,
      stoppedFor: 0,
      hornedUntil: -1,
      intent: "straight",
      blinker: "none",
      decidedJx: null,
      decidedJz: null,
      turning: false,
      turnPath: [],
      turnS: 0,
      turnLen: 0,
      turnHeld: 0,
      turnEnd: { x: 0, z: 0, yaw: 0 },
      turnNext: { roadAxis: partial.roadAxis, roadPos: partial.roadPos, lane: partial.lane },
    };
  }

  private spawnOne(forceKind?: VehicleKind, forceColor?: number): boolean {
    const { xs, zs } = getCityAxes();
    const roadAxis: "x" | "z" = Math.random() < 0.5 ? "z" : "x";
    const roadPos =
      roadAxis === "z"
        ? xs[Math.floor(Math.random() * xs.length)]
        : zs[Math.floor(Math.random() * zs.length)];
    const laneSign = Math.random() < 0.5 ? -1 : 1;
    const lane = laneSign * (1 + Math.floor(Math.random() * 2));
    const alongMin = roadAxis === "z" ? cityMinZ() : cityMinX();
    const alongMax = roadAxis === "z" ? cityMaxZ() : cityMaxX();
    const along = alongMin + Math.random() * (alongMax - alongMin) * 0.9 + (alongMax - alongMin) * 0.05;

    if (this.laneOccupied(roadAxis, roadPos, lane, along)) return false;

    const kind = forceKind ?? randomTrafficKind();
    const color =
      forceColor ??
      (kind === "schoolBus"
        ? SCHOOL_BUS_YELLOW
        : kind === "lorry"
          ? LORRY_COLORS[Math.floor(Math.random() * LORRY_COLORS.length)]
          : kind === "auto"
            ? AUTO_COLORS[Math.floor(Math.random() * AUTO_COLORS.length)]
            : CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)]);
    const dir = travelDirFromLane(lane);
    const idx = laneIndexFromLane(lane);
    let x = 0;
    let z = 0;
    let yaw = 0;
    if (roadAxis === "z") {
      const pose = poseOnRoad("z", roadPos, along, dir, idx);
      x = pose.x;
      z = pose.z;
      yaw = pose.yaw;
    } else {
      const pose = poseOnRoad("x", roadPos, along, dir, idx);
      x = pose.x;
      z = pose.z;
      yaw = pose.yaw;
    }
    if (this.tooCloseToParking(x, z)) return false;
    const v = new Vehicle(color, false, kind);
    v.setPose(x, z, yaw);
    v.speed = 7 + Math.random() * 6;
    this.scene.add(v.mesh);
    this.cars.push(
      this.freshAI({
        vehicle: v,
        roadAxis,
        roadPos,
        lane,
        targetSpeed:
          kind === "lorry"
            ? 6 + Math.random() * 3.5
            : isHeavyVehicle(kind)
              ? 7 + Math.random() * 4
              : kind === "auto"
                ? 7 + Math.random() * 3.5 // autos putter along ~25-38 km/h
                : 9 + Math.random() * 7,
      }),
    );
    return true;
  }

  reset() {
    for (const c of this.cars) this.scene.remove(c.vehicle.mesh);
    this.cars = [];
    this.spawnAll();
  }

  /** Respawn all traffic away from the player (call after player pose is set) */
  resetAround(player: Vehicle) {
    for (const c of this.cars) this.scene.remove(c.vehicle.mesh);
    this.cars = [];
    const forced: { kind: VehicleKind; color: number }[] = [
      { kind: "schoolBus", color: SCHOOL_BUS_YELLOW },
      { kind: "schoolBus", color: SCHOOL_BUS_YELLOW },
      { kind: "truck", color: 0xef6c00 },
      { kind: "truck", color: 0x37474f },
      { kind: "lorry", color: 0xd84315 },
      { kind: "lorry", color: 0x1565c0 },
      { kind: "auto", color: 0xf9c500 },
      { kind: "auto", color: 0xf9c500 },
      { kind: "auto", color: 0x2e7d32 },
      { kind: "auto", color: 0xffd54f },
      { kind: "auto", color: 0x1b5e20 },
    ];
    for (const f of forced) {
      let tries = 0;
      while (tries++ < 50) {
        if (!this.spawnOne(f.kind, f.color)) continue;
        const last = this.cars[this.cars.length - 1];
        if (
          this.tooCloseToPlayer(
            player,
            last.roadAxis,
            last.roadPos,
            last.roadAxis === "z" ? last.vehicle.position.z : last.vehicle.position.x,
            last.lane,
          )
        ) {
          this.scene.remove(last.vehicle.mesh);
          this.cars.pop();
          continue;
        }
        break;
      }
    }
    let attempts = 0;
    while (this.cars.length < TRAFFIC_COUNT && attempts < TRAFFIC_COUNT * 50) {
      attempts++;
      if (!this.spawnOne()) continue;
      const last = this.cars[this.cars.length - 1];
      if (
        this.tooCloseToPlayer(
          player,
          last.roadAxis,
          last.roadPos,
          last.roadAxis === "z" ? last.vehicle.position.z : last.vehicle.position.x,
          last.lane,
        )
      ) {
        this.scene.remove(last.vehicle.mesh);
        this.cars.pop();
      }
    }
  }

  private time = 0;

  /**
   * Player honked: drivers ahead in the player's forward cone lose their hesitation
   * and pull away if the road is physically clear (like a real stalled bus at a green).
   */
  honk(player: Vehicle): number {
    const fwd = player.forward;
    let woke = 0;
    for (const ai of this.cars) {
      const dx = ai.vehicle.position.x - player.position.x;
      const dz = ai.vehicle.position.z - player.position.z;
      const along = dx * fwd.x + dz * fwd.z;
      const lat = Math.abs(dx * fwd.z - dz * fwd.x);
      if (along < 0.5 || along > 32 || lat > 6) continue;
      ai.hornedUntil = this.time + 4;
      if (ai.reactTimer > 0) woke++;
      ai.reactTimer = 0;
    }
    return woke;
  }

  /** Reaction delay when a light turns green (buses/trucks are lazier) */
  private greenReaction(kind: string): number {
    const heavy = isHeavyVehicle(kind as VehicleKind);
    return heavy ? 0.9 + Math.random() * 1.3 : 0.35 + Math.random() * 0.7;
  }

  update(dt: number, player: Vehicle, peds?: PedestrianSystem) {
    this.time += dt;
    this.world.updateLights(dt, {
      x: player.position.x,
      z: player.position.z,
      yaw: player.yaw,
    });
    const half = cityHalfSpan();
    const stopLine = STOP_LINE_SETBACK;

    for (const ai of this.cars) {
      const v = ai.vehicle;
      v.crashed = false;
      if (Math.abs(v.speed) < 0.3) ai.stoppedFor += dt;
      else ai.stoppedFor = 0;

      // --- Turning through junction ---
      if (ai.turning) {
        this.updateTurn(ai, dt, player, peds);
        continue;
      }
      const honked = this.time < ai.hornedUntil;

      // Hold the keep-left lane. Freeze heading until a committed turn is about to start
      // so the car can follow a real arc instead of snapping 90°.
      const dir = travelDirFromLane(ai.lane);
      const idx = laneIndexFromLane(ai.lane);
      const holdHeading = ai.intent === "straight" || ai.decidedJx === null;
      if (ai.roadAxis === "z") {
        const desiredX = laneLateral("z", ai.roadPos, dir, idx);
        if ((desiredX - ai.roadPos) * (v.position.x - ai.roadPos) < 0) {
          v.position.x = desiredX;
        } else {
          v.position.x = THREE.MathUtils.damp(v.position.x, desiredX, 12, dt);
        }
        if (holdHeading) v.yaw = yawForTravel("z", dir);
      } else {
        const desiredZ = laneLateral("x", ai.roadPos, dir, idx);
        if ((desiredZ - ai.roadPos) * (v.position.z - ai.roadPos) < 0) {
          v.position.z = desiredZ;
        } else {
          v.position.z = THREE.MathUtils.damp(v.position.z, desiredZ, 12, dt);
        }
        if (holdHeading) v.yaw = yawForTravel("x", dir);
      }

      let throttle = 0.5;
      let brake = 0;
      let desiredSpeed = ai.targetSpeed;

      // Same-lane vehicle ahead
      const ahead = this.findAheadSameLane(ai, 50);
      if (ahead) {
        const gap = ahead.dist;
        const leadSpeed = Math.abs(ahead.car.vehicle.speed);
        if (gap < 7) {
          brake = 1;
          throttle = 0;
          desiredSpeed = 0;
          const push = (7 - gap) * 0.5;
          const fwd = v.forward;
          v.position.x -= fwd.x * push * dt * 8;
          v.position.z -= fwd.z * push * dt * 8;
          v.speed = Math.min(v.speed, Math.max(0, leadSpeed - 2));
        } else if (gap < 12) {
          brake = 0.7;
          throttle = 0;
          desiredSpeed = Math.max(0, leadSpeed - 1.5);
        } else if (gap < 20) {
          throttle = 0.2;
          brake = 0.1;
          desiredSpeed = Math.max(leadSpeed, 2);
        } else if (gap < 32) {
          desiredSpeed = Math.min(desiredSpeed, leadSpeed + 1.5);
        }
      }

      // Player ahead in corridor — always yield (player route priority)
      const toPlayer = player.position.clone().sub(v.position);
      const fwd = v.forward;
      const alongP = toPlayer.dot(fwd);
      const lateral = Math.abs(toPlayer.x * fwd.z - toPlayer.z * fwd.x);
      if (alongP > 1 && alongP < 22 && lateral < 2.6) {
        if (alongP < 10) {
          brake = 1;
          throttle = 0;
          desiredSpeed = 0;
        } else {
          throttle = 0.1;
          brake = 0.45;
          desiredSpeed = Math.min(desiredSpeed, Math.abs(player.speed));
        }
      }
      // Player coming up behind on same lane — don't block; ease forward on green only later
      else if (alongP < -2 && alongP > -14 && lateral < 2.2 && Math.abs(player.speed) > Math.abs(v.speed) + 1) {
        desiredSpeed = Math.min(desiredSpeed + 1.5, ai.targetSpeed + 2);
      }

      // Yield to pedestrians on the zebra / in our lane — including after green
      const pedGap = this.pedGapAhead(ai, peds);
      const pedBlock = pedGap !== null && pedGap < 14;
      if (pedBlock) {
        brake = 1;
        throttle = 0;
        desiredSpeed = 0;
        if (pedGap !== null && pedGap < 5.5) v.speed = Math.min(v.speed, 0.35);
      }

      // Junction / lights / turns
      const near = this.world.nearestLight(v.position.x, v.position.z, v.yaw);
      let heldNow = false;
      if (near && near.dist < BLOCK * 0.45) {
        const junc = this.world.junctionAt(near.light.x, near.light.z);
        const arms = junc?.arms ?? near.light.arms;
        const travel = travelDirFromLane(ai.lane);
        const alongToLight =
          ai.roadAxis === "z"
            ? travel * (near.light.z - v.position.z)
            : travel * (near.light.x - v.position.x);
        const approaching = alongToLight > 0.5;
        const insideBox = near.dist < ROAD_WIDTH * 0.52;
        const beforeStop = near.dist > stopLine - 0.35;

        if (approaching || insideBox) {
          if (ai.decidedJx !== near.light.x || ai.decidedJz !== near.light.z) {
            this.pickIntent(ai, arms);
            ai.decidedJx = near.light.x;
            ai.decidedJz = near.light.z;
          }
          ai.blinker = ai.intent === "left" ? "left" : ai.intent === "right" ? "right" : "none";

          const arm = approachArmFromTravel(ai.roadAxis, travel);
          const sig = this.world.signalForApproach(arm, near.light);
          const distToStop = near.dist - stopLine;
          const leadToLight = !ahead || ahead.dist > Math.max(2, distToStop - 0.5);

          if (beforeStop && approaching) {
            // Still before stop line — full signal obedience
            if (sig === "RED" || (sig === "YELLOW" && (distToStop > 5 || v.speed < 5.5))) {
              if (leadToLight) {
                if (distToStop < 22) {
                  brake = 1;
                  throttle = 0;
                  desiredSpeed = 0;
                  if (distToStop < 5) {
                    v.speed = 0;
                    heldNow = true;
                  }
                } else if (distToStop < 45) {
                  throttle = 0;
                  brake = Math.max(brake, 0.6);
                  desiredSpeed = Math.min(desiredSpeed, Math.max(1, distToStop * 0.28));
                }
              } else if (ahead && ahead.dist < 14) {
                brake = 1;
                throttle = 0;
                desiredSpeed = 0;
              }
            } else {
              // GREEN (or late yellow) — go when clear
              if (ai.heldAtLine && !heldNow && ai.reactTimer <= 0 && !honked) {
                // light just turned: human reaction delay before pulling away
                ai.reactTimer = this.greenReaction(v.kind);
              }
              const hesitating = ai.reactTimer > 0 && !honked && Math.abs(v.speed) < 0.5;
              if (hesitating) {
                ai.reactTimer -= dt;
                brake = 1;
                throttle = 0;
                desiredSpeed = 0;
              } else if (
                distToStop < 10 &&
                !(honked && ai.stoppedFor > 1.5) &&
                this.junctionBlockedFor(ai, near.light.x, near.light.z)
              ) {
                brake = 1;
                throttle = 0;
                desiredSpeed = 0;
              } else if (pedBlock && distToStop < 18) {
                brake = 1;
                throttle = 0;
                desiredSpeed = 0;
              } else if (ai.intent !== "straight" && distToStop < (ai.intent === "right" ? 7.2 : 5.4)) {
                if (!this.beginTurn(ai, near.light.x, near.light.z, player)) {
                  desiredSpeed = Math.min(desiredSpeed, 1.4);
                }
              } else if (ai.intent !== "straight" && distToStop < 18) {
                // Ease down for the turn (controller below handles braking if too fast)
                desiredSpeed = Math.min(desiredSpeed, 5.5);
              }
            }
          } else if (insideBox) {
            if (sig === "RED") {
              // Finish clearing — do not stop in the middle
              desiredSpeed = Math.max(desiredSpeed, 7);
              throttle = Math.max(throttle, 0.6);
              brake = 0;
            } else if (ai.intent !== "straight" && !ai.turning) {
              if (!this.beginTurn(ai, near.light.x, near.light.z, player)) {
                desiredSpeed = Math.min(desiredSpeed, 1.2);
              }
            }
          }
        }
      } else if (ai.decidedJx !== null) {
        const dj = this.world.junctionAt(ai.decidedJx, ai.decidedJz ?? 0);
        if (!dj || Math.hypot(v.position.x - dj.x, v.position.z - dj.z) > ROAD_WIDTH * 1.2) {
          ai.decidedJx = null;
          ai.decidedJz = null;
          ai.intent = "straight";
          ai.blinker = "none";
        }
      }

      ai.heldAtLine = heldNow;
      if (!heldNow && ai.reactTimer > 0 && Math.abs(v.speed) > 0.5) ai.reactTimer = 0;

      if (this.nearConflict(ai, 6)) {
        brake = 1;
        throttle = 0;
        desiredSpeed = 0;
      }

      if (pedBlock) {
        brake = 1;
        throttle = 0;
        desiredSpeed = 0;
      }

      // Stall watchdog: stationary for a long time with nothing physically in front → go.
      // Covers any logic deadlock (and a honked driver clears it sooner).
      if (
        desiredSpeed === 0 &&
        !heldNow &&
        !pedBlock &&
        ai.stoppedFor > (honked ? 1.2 : 4) &&
        (!ahead || ahead.dist > 9) &&
        !this.nearConflict(ai, 6)
      ) {
        desiredSpeed = Math.min(ai.targetSpeed, 6);
        throttle = 0.5;
        brake = 0;
      }

      // Final speed controller. Brake ONLY to hold or when too fast: vehicle.update ignores
      // throttle whenever brake > 0.01, so any "advisory" brake left above would otherwise
      // pin a stopped vehicle forever (bus with indicator on, bike at a green light...).
      const spd = Math.abs(v.speed);
      if (desiredSpeed <= 0.05) {
        throttle = 0;
        brake = Math.max(brake, 0.8);
      } else if (spd > desiredSpeed + 0.5) {
        throttle = 0;
        brake = Math.max(brake, 0.35);
      } else if (spd < desiredSpeed - 0.5) {
        brake = 0;
        throttle = Math.max(throttle, spd < 1 ? 0.6 : 0.45);
      } else {
        brake = 0;
        throttle = Math.max(throttle, 0.15);
      }

      v.signalBlink = ai.blinker;
      v.signalBrake = brake > 0.35;
      const input: DriveInput = { throttle, brake, steer: 0, handbrake: false };
      v.autoDrive = true;
      v.update(dt, input);

      if (Math.abs(v.position.x) > half + 40 || Math.abs(v.position.z) > half + 40) {
        this.respawn(ai, half);
      } else if (this.tooCloseToParking(v.position.x, v.position.z)) {
        this.respawn(ai, half, player);
      } else if (v.position.distanceTo(player.position) > 220) {
        this.respawn(ai, half, player);
      }
    }

    this.resolveOverlaps();
  }

  private pickIntent(ai: AICar, arms: JunctionArms) {
    // Which way is this car arriving from?
    const goingPos = Math.sign(ai.lane) > 0;
    let canStraight = true;
    let canLeft = true;
    let canRight = true;

    if (ai.roadAxis === "z") {
      // +Z (northbound) or -Z (southbound) — left/right = screen-left/right
      if (goingPos) {
        canStraight = arms.n;
        canLeft = arms.e; // screen-left when facing +Z is east
        canRight = arms.w;
      } else {
        canStraight = arms.s;
        canLeft = arms.w; // screen-left when facing −Z is west
        canRight = arms.e;
      }
    } else {
      // +X (eastbound) or -X (westbound)
      if (goingPos) {
        canStraight = arms.e;
        canLeft = arms.s; // screen-left when facing +X is −Z (south)
        canRight = arms.n;
      } else {
        canStraight = arms.w;
        canLeft = arms.n;
        canRight = arms.s;
      }
    }

    const options: { t: TurnIntent; w: number }[] = [];
    if (canStraight) options.push({ t: "straight", w: 0.55 });
    if (canLeft) options.push({ t: "left", w: 0.22 });
    if (canRight) options.push({ t: "right", w: 0.23 });
    if (options.length === 0) {
      ai.intent = "straight";
      return;
    }
    const sum = options.reduce((a, o) => a + o.w, 0);
    let r = Math.random() * sum;
    for (const o of options) {
      r -= o.w;
      if (r <= 0) {
        ai.intent = o.t;
        return;
      }
    }
    ai.intent = options[0].t;
  }

  private beginTurn(ai: AICar, jx: number, jz: number, player: Vehicle): boolean {
    if (ai.intent === "straight") return false;
    if (this.sameTurnBusy(ai, player, jx, jz)) return false;

    const v = ai.vehicle;
    const dir = travelDirFromLane(ai.lane);
    const idx = laneIndexFromLane(ai.lane);
    const left = ai.intent === "left";
    const clear = ROAD_WIDTH / 2 + (left ? 4.2 : 7.0);

    let nextAxis: "x" | "z";
    let nextPos: number;
    let nextDir: TravelDir;
    let endX: number;
    let endZ: number;
    let endYaw: number;

    if (ai.roadAxis === "z") {
      // Turn onto EW road through this junction
      nextAxis = "x";
      nextPos = jz;
      // Screen-left: northbound → east (+X); southbound → west (−X)
      if (dir > 0) nextDir = left ? 1 : -1;
      else nextDir = left ? -1 : 1;
      const pose = poseOnRoad("x", jz, jx + nextDir * clear, nextDir, idx);
      endX = pose.x;
      endZ = pose.z;
      endYaw = pose.yaw;
    } else {
      nextAxis = "z";
      nextPos = jx;
      // Screen-left: eastbound → south (−Z); westbound → north (+Z)
      if (dir > 0) nextDir = left ? -1 : 1;
      else nextDir = left ? 1 : -1;
      const pose = poseOnRoad("z", jx, jz + nextDir * clear, nextDir, idx);
      endX = pose.x;
      endZ = pose.z;
      endYaw = pose.yaw;
    }

    const nextLane = toSignedLane(nextDir, idx);

    // Start exactly where the car is, heading exactly as it is: no snap, no teleport.
    const p0 = { x: v.position.x, z: v.position.z, yaw: v.yaw };
    const p3 = { x: endX, z: endZ, yaw: endYaw };
    ai.turnPath = sampleTurnPath(p0, p3, left);
    ai.turnLen = ai.turnPath[ai.turnPath.length - 1].s;
    ai.turnS = 0;
    ai.turnHeld = 0;
    ai.turning = true;
    ai.turnEnd = p3;
    ai.turnNext = { roadAxis: nextAxis, roadPos: nextPos, lane: nextLane };
    ai.blinker = left ? "left" : "right";
    v.speed = Math.min(v.speed, left ? 4.6 : 5.6);
    return true;
  }

  /** Position/heading at distance s along the sampled path (linear interpolation) */
  private sampleAt(path: TurnSample[], s: number): { x: number; z: number; yaw: number } {
    if (s <= 0) return path[0];
    const last = path[path.length - 1];
    if (s >= last.s) return last;
    let lo = 0;
    let hi = path.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (path[mid].s <= s) lo = mid;
      else hi = mid;
    }
    const a = path[lo];
    const b = path[hi];
    const f = (s - a.s) / Math.max(1e-6, b.s - a.s);
    let dy = b.yaw - a.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    return { x: a.x + (b.x - a.x) * f, z: a.z + (b.z - a.z) * f, yaw: a.yaw + dy * f };
  }

  /** Bumper gap from `self`'s nose toward `other` along `self`'s heading. */
  private pathGapTo(self: Vehicle, other: Vehicle): { along: number; lat: number; bumper: number } {
    const dx = other.position.x - self.position.x;
    const dz = other.position.z - self.position.z;
    const fwd = self.forward;
    const along = dx * fwd.x + dz * fwd.z;
    const lat = Math.abs(dx * fwd.z - dz * fwd.x);
    return { along, lat, bumper: along - (self.length + other.length) * 0.5 };
  }

  /**
   * Cap turn speed so we never occupy the same arc as the player or another
   * vehicle already going through this left/right.
   */
  private turnFollowSpeed(ai: AICar, player: Vehicle, want: number): number {
    const v = ai.vehicle;
    let cap = want;
    const apply = (o: Vehicle) => {
      const g = this.pathGapTo(v, o);
      if (g.along < -1.4 || g.lat > 3.6 || g.bumper > 9) return;
      if (g.bumper < 2.3) cap = 0;
      else if (g.bumper < 6.2) {
        const follow = Math.max(0, o.speed - 0.5);
        const stop = Math.sqrt(Math.max(0, 2 * 4.2 * Math.max(0, g.bumper - 2.2)));
        cap = Math.min(cap, follow, stop);
      }
    };
    apply(player);
    for (const other of this.cars) {
      if (other === ai) continue;
      if (other.vehicle.position.distanceToSquared(v.position) > 220) continue;
      apply(other.vehicle);
    }
    return cap;
  }

  /** True when the same left/right is already occupied close ahead (wait, then follow). */
  private sameTurnBusy(ai: AICar, player: Vehicle, jx: number, jz: number): boolean {
    const v = ai.vehicle;
    const minBumper = 5.0;
    const playerSame =
      player.signalBlink === ai.intent &&
      Math.hypot(player.position.x - jx, player.position.z - jz) < ROAD_WIDTH * 0.95;
    if (playerSame || Math.hypot(player.position.x - v.position.x, player.position.z - v.position.z) < 12) {
      const g = this.pathGapTo(v, player);
      // Player already on this turn, beside us, or just ahead → we wait (player has route priority)
      if (player.signalBlink === ai.intent && g.lat < 3.8 && g.along > -3 && g.bumper < minBumper) return true;
      if (g.along > 0.2 && g.lat < 3.2 && g.bumper < minBumper) return true;
    }
    for (const other of this.cars) {
      if (other === ai) continue;
      const sameArc = other.turning && other.intent === ai.intent;
      if (!sameArc && !(other.blinker === ai.intent && other.decidedJx === ai.decidedJx)) continue;
      const g = this.pathGapTo(v, other.vehicle);
      if (g.along > -2 && g.lat < 3.6 && g.bumper < minBumper) return true;
    }
    return false;
  }

  private updateTurn(ai: AICar, dt: number, player: Vehicle, peds?: PedestrianSystem) {
    const v = ai.vehicle;
    const progress = ai.turnLen > 0 ? ai.turnS / ai.turnLen : 1;

    // Real-car speed profile: brake into the corner, slowest at the apex, feed power out.
    const apex = ai.intent === "left" ? 3.4 : 4.4;
    const entry = ai.intent === "left" ? 4.6 : 5.6;
    const exit = 7.5;
    const want =
      progress < 0.45
        ? entry + (apex - entry) * (progress / 0.45)
        : apex + (exit - apex) * ((progress - 0.45) / 0.55);

    // Yield mid-turn to anyone on our arc (player or another vehicle taking the same left/right)
    const target = this.turnFollowSpeed(ai, player, want);
    const pedGap = this.pedGapAhead(ai, peds);
    const pedStop = pedGap !== null && pedGap < 9;
    ai.turnHeld = target < 0.4 || pedStop ? ai.turnHeld + dt : 0;
    // Watchdog: if we've been pinned in the box too long, creep (never stay forever) —
    // but never creep through a pedestrian on the zebra.
    const go = pedStop ? 0 : ai.turnHeld > 8 ? Math.max(target, 1.6) : target;

    // Smooth accel / braking (heavy vehicles are lazier)
    const heavy = isHeavyVehicle(v.kind);
    const accel = heavy ? 2.2 : 3.6;
    const decel = 5.5;
    if (go > v.speed) v.speed = Math.min(go, v.speed + accel * dt);
    else v.speed = Math.max(go, v.speed - decel * dt);
    if (v.speed < 0.05) v.speed = 0;

    ai.turnS += v.speed * dt;
    const pose = this.sampleAt(ai.turnPath, ai.turnS);
    v.position.x = pose.x;
    v.position.z = pose.z;
    v.yaw = pose.yaw;
    const look = this.sampleAt(ai.turnPath, Math.min(ai.turnLen, ai.turnS + 2.4));
    let dy = look.yaw - pose.yaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    v.steer = THREE.MathUtils.clamp(dy * 1.8, -0.62, 0.62);
    if (v.speed > 0.1) spinWheels(v.mesh, v.speed, dt);

    v.signalBlink = ai.blinker;
    v.signalBrake = go < v.speed - 0.2 || go < 0.4;
    setVehicleSignals(v.mesh, {
      headlights: true,
      brake: v.signalBrake,
      blinkLeft: ai.blinker === "left",
      blinkRight: ai.blinker === "right",
      time: performance.now() * 0.001,
    });
    v.syncMesh();

    if (ai.turnS >= ai.turnLen - 0.01) {
      ai.turning = false;
      ai.roadAxis = ai.turnNext.roadAxis;
      ai.roadPos = ai.turnNext.roadPos;
      ai.lane = ai.turnNext.lane;
      v.yaw = ai.turnEnd.yaw;
      v.position.x = ai.turnEnd.x;
      v.position.z = ai.turnEnd.z;
      v.steer = 0;
      ai.blinker = "none";
      ai.intent = "straight";
      v.signalBlink = "none";
      v.syncMesh();
    }
  }

  /**
   * Block green departure only for true conflicts: someone turning through the box,
   * or a different-axis car already past the stop line inside the asphalt.
   * Cars waiting on red outside the box must NOT freeze our green.
   */
  private junctionBlockedFor(self: AICar, jx: number, jz: number): boolean {
    const box = ROAD_WIDTH * 0.48;
    for (const other of this.cars) {
      if (other === self) continue;
      const ox = other.vehicle.position.x - jx;
      const oz = other.vehicle.position.z - jz;
      if (Math.abs(ox) > box || Math.abs(oz) > box) continue;

      // Same approach — follow, don't block
      if (
        !other.turning &&
        other.roadAxis === self.roadAxis &&
        other.roadPos === self.roadPos &&
        Math.sign(other.lane) === Math.sign(self.lane)
      ) {
        continue;
      }

      if (other.turning) return true;

      // Different axis car deep in the box (actually crossing)
      if (other.roadAxis !== self.roadAxis && Math.hypot(ox, oz) < ROAD_WIDTH * 0.42) {
        return true;
      }
    }
    return false;
  }

  /** Imminent nose-to-side collision only (tight) */
  private nearConflict(ai: AICar, radius: number): boolean {
    const v = ai.vehicle;
    for (const other of this.cars) {
      if (other === ai) continue;
      if (other.roadAxis === ai.roadAxis && other.roadPos === ai.roadPos) continue;
      const d = v.position.distanceTo(other.vehicle.position);
      if (d > radius) continue;
      if (v.touches(other.vehicle)) return true;
      const to = other.vehicle.position.clone().sub(v.position);
      const along = to.dot(v.forward);
      const lat = Math.abs(to.x * v.forward.z - to.z * v.forward.x);
      // Only if they're crossing through our nose, not sitting at a side stop line
      if (along > 0.5 && along < 5 && lat < 2.8 && d < 5.5) return true;
    }
    return false;
  }

  private resolveOverlaps() {
    for (let i = 0; i < this.cars.length; i++) {
      for (let j = i + 1; j < this.cars.length; j++) {
        const a = this.cars[i];
        const b = this.cars[j];
        if (!a.vehicle.touches(b.vehicle) && !aabbHit(a.vehicle.aabb(), b.vehicle.aabb())) continue;

        // Push apart along separation vector
        const dx = b.vehicle.position.x - a.vehicle.position.x;
        const dz = b.vehicle.position.z - a.vehicle.position.z;
        const len = Math.hypot(dx, dz) || 0.01;
        const push = 0.55;
        a.vehicle.position.x -= (dx / len) * push;
        a.vehicle.position.z -= (dz / len) * push;
        b.vehicle.position.x += (dx / len) * push;
        b.vehicle.position.z += (dz / len) * push;
        a.vehicle.speed = Math.min(a.vehicle.speed, 2);
        b.vehicle.speed = Math.min(b.vehicle.speed, 2);
        a.vehicle.syncMesh();
        b.vehicle.syncMesh();
      }
    }
  }

  private respawn(ai: AICar, half: number, player?: Vehicle) {
    const { xs, zs } = getCityAxes();
    for (let tryN = 0; tryN < 40; tryN++) {
      const roadAxis: "x" | "z" = Math.random() < 0.5 ? "z" : "x";
      let roadPos =
        roadAxis === "z"
          ? xs[Math.floor(Math.random() * xs.length)]
          : zs[Math.floor(Math.random() * zs.length)];
      const alongMin = roadAxis === "z" ? cityMinZ() : cityMinX();
      const alongMax = roadAxis === "z" ? cityMaxZ() : cityMaxX();
      let along = alongMin + Math.random() * (alongMax - alongMin);

      // Prefer spawning BEHIND the player on their road — never pop in front
      if (player && Math.random() < 0.55) {
        const useZ = Math.abs(Math.cos(player.yaw)) > 0.5;
        const axisMatch = useZ ? "z" : "x";
        if (roadAxis === axisMatch || Math.random() < 0.35) {
          const playerAlong = useZ ? player.position.z : player.position.x;
          const playerCross = useZ ? player.position.x : player.position.z;
          const fwdAlong = useZ ? Math.cos(player.yaw) : Math.sin(player.yaw);
          along = playerAlong - Math.sign(fwdAlong || 1) * (35 + Math.random() * 55);
          // Snap to nearest real road under the player
          const roads = useZ ? xs : zs;
          let snapped = roads[0];
          let best = Infinity;
          for (const r of roads) {
            const d = Math.abs(r - playerCross);
            if (d < best) {
              best = d;
              snapped = r;
            }
          }
          if (Math.abs(snapped - roadPos) < 50 || Math.random() < 0.5) {
            const lane = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2));
            if (Math.abs(along) > half + 40) continue;
            if (this.laneOccupied(axisMatch, snapped, lane, along)) continue;
            if (this.tooCloseToPlayer(player, axisMatch, snapped, along, lane)) continue;

            ai.roadPos = snapped;
            ai.roadAxis = axisMatch;
            ai.lane = lane;
            ai.turning = false;
            ai.intent = "straight";
            ai.blinker = "none";
            ai.decidedJx = null;
            ai.decidedJz = null;
            ai.reactTimer = 0;
            ai.heldAtLine = false;
            ai.stoppedFor = 0;
            ai.hornedUntil = -1;
            const pose = poseOnRoad(
              axisMatch,
              snapped,
              along,
              travelDirFromLane(lane),
              laneIndexFromLane(lane),
            );
            if (this.tooCloseToParking(pose.x, pose.z)) continue;
            ai.vehicle.setPose(pose.x, pose.z, pose.yaw);
            ai.vehicle.speed = 6 + Math.random() * 5;
            ai.vehicle.crashed = false;
            ai.vehicle.signalBlink = "none";
            return;
          }
        }
      }

      const lane = (Math.random() < 0.5 ? -1 : 1) * (1 + Math.floor(Math.random() * 2));
      if (this.laneOccupied(roadAxis, roadPos, lane, along)) continue;
      if (player && this.tooCloseToPlayer(player, roadAxis, roadPos, along, lane)) continue;

      ai.roadPos = roadPos;
      ai.roadAxis = roadAxis;
      ai.lane = lane;
      ai.turning = false;
      ai.intent = "straight";
      ai.blinker = "none";
      ai.decidedJx = null;
      ai.decidedJz = null;
      ai.reactTimer = 0;
      ai.heldAtLine = false;
      ai.stoppedFor = 0;
      ai.hornedUntil = -1;
      const pose = poseOnRoad(
        roadAxis,
        roadPos,
        along,
        travelDirFromLane(lane),
        laneIndexFromLane(lane),
      );
      if (this.tooCloseToParking(pose.x, pose.z)) continue;
      ai.vehicle.setPose(pose.x, pose.z, pose.yaw);
      ai.vehicle.speed = 6 + Math.random() * 5;
      ai.vehicle.crashed = false;
      ai.vehicle.signalBlink = "none";
      return;
    }
  }

  /** Keep AI off the destination block interior (roads around it stay open) */
  private tooCloseToParking(x: number, z: number): boolean {
    const p = this.world.destinationPlace;
    if (!p) return false;
    const pad = ROAD_WIDTH / 2 + 2.5;
    return x > p.x0 + pad && x < p.x1 - pad && z > p.z0 + pad && z < p.z1 - pad;
  }

  /** Reject spawns that would appear in front of / on top of the player */
  private tooCloseToPlayer(
    player: Vehicle,
    roadAxis: "x" | "z",
    roadPos: number,
    along: number,
    lane: number,
  ): boolean {
    const pose = poseOnRoad(
      roadAxis,
      roadPos,
      along,
      travelDirFromLane(lane),
      laneIndexFromLane(lane),
    );
    const dx = pose.x - player.position.x;
    const dz = pose.z - player.position.z;
    const dist = Math.hypot(dx, dz);
    if (dist < 28) return true;
    // In front of player within 70m cone
    const alongFwd = dx * player.forward.x + dz * player.forward.z;
    const lat = Math.abs(dx * player.forward.z - dz * player.forward.x);
    if (alongFwd > 8 && alongFwd < 70 && lat < 10) return true;
    return false;
  }

  /** Bumper gap to the nearest pedestrian on the carriageway in our corridor. */
  private pedGapAhead(ai: AICar, peds?: PedestrianSystem): number | null {
    if (!peds) return null;
    const v = ai.vehicle;
    const fwd = v.forward;
    let best: number | null = null;
    for (const ped of peds.peds) {
      if (ped.mesh.userData.down) continue;
      if (ped.mode !== "cross" && !peds.isOnRoad(ped)) continue;
      const dx = ped.mesh.position.x - v.position.x;
      const dz = ped.mesh.position.z - v.position.z;
      const along = dx * fwd.x + dz * fwd.z;
      const lat = Math.abs(dx * fwd.z - dz * fwd.x);
      if (along < 0.3 || along > 16) continue;
      if (lat > 3.5) continue;
      if (best === null || along < best) best = along;
    }
    return best;
  }

  private findAheadSameLane(ai: AICar, maxDist: number): { dist: number; car: AICar } | null {
    const v = ai.vehicle;
    const fwd = v.forward;
    let best: { dist: number; car: AICar } | null = null;
    for (const other of this.cars) {
      if (other === ai) continue;
      if (other.turning) {
        // treat turning cars near our path as ahead obstacles
        const d = other.vehicle.position.clone().sub(v.position);
        const along = d.dot(fwd);
        if (along < 0.5 || along > maxDist) continue;
        const lat = Math.abs(d.x * fwd.z - d.z * fwd.x);
        if (lat > 3.5) continue;
        if (!best || along < best.dist) best = { dist: along, car: other };
        continue;
      }
      if (other.roadAxis !== ai.roadAxis || other.roadPos !== ai.roadPos || other.lane !== ai.lane) {
        continue;
      }
      const d = other.vehicle.position.clone().sub(v.position);
      const along = d.dot(fwd);
      if (along < 0.5 || along > maxDist) continue;
      if (!best || along < best.dist) best = { dist: along, car: other };
    }
    return best;
  }

  collidePlayer(player: Vehicle): boolean {
    for (const ai of this.cars) {
      if (player.touches(ai.vehicle)) return true;
    }
    return false;
  }

  softRoadConstraint(player: Vehicle) {
    let minDist = Infinity;
    let push = new THREE.Vector3();
    for (const r of this.world.roads) {
      if (r.axis === "z") {
        const d = player.position.x - r.pos;
        if (Math.abs(d) < minDist) {
          minDist = Math.abs(d);
          push.set(-Math.sign(d), 0, 0);
        }
      } else {
        const d = player.position.z - r.pos;
        if (Math.abs(d) < minDist) {
          minDist = Math.abs(d);
          push.set(0, 0, -Math.sign(d));
        }
      }
    }
    if (minDist > ROAD_WIDTH / 2 + 0.4) {
      player.position.addScaledVector(push, (minDist - ROAD_WIDTH / 2) * 0.08);
      player.speed *= 0.92;
      player.syncMesh();
      return true;
    }
    return false;
  }
}
