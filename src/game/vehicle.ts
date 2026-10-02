import * as THREE from "three";
import {
  BRAKE,
  GEAR_STATS,
  HANDBRAKE,
  MAX_STEER,
  ROLLING_RESIST,
  STEER_SPEED,
} from "./constants";
import { createCarMesh, setVehicleSignals, spinWheels, type VehicleKind } from "./carMesh";

export type Gear = "P" | "R" | "N" | "1" | "2" | "3" | "4" | "5";

export interface DriveInput {
  throttle: number;
  brake: number;
  steer: number;
  handbrake: boolean;
}

export class Vehicle {
  mesh: THREE.Group;
  position = new THREE.Vector3();
  yaw = 0;
  speed = 0;
  steer = 0;
  gear: Gear = "1";
  fuel = 100;
  crashed = false;
  width: number;
  length: number;
  isPlayer: boolean;
  kind: VehicleKind;
  /** For AI: ignore gear limits, use automatic drive */
  autoDrive = false;
  /** Turn / brake lights for mesh */
  signalBlink: "none" | "left" | "right" = "none";
  /** When set (auto mode), overrides steer-derived blinkers */
  blinkOverride: "none" | "left" | "right" | null = null;
  signalBrake = false;
  private signalTime = 0;

  constructor(color: number, isPlayer = false, kind: VehicleKind = "sedan") {
    this.kind = kind;
    this.mesh = createCarMesh(color, kind);
    this.isPlayer = isPlayer;
    const dims = this.mesh.userData.dims as { width: number; length: number };
    this.width = dims.width;
    this.length = dims.length;
    this.gear = isPlayer ? "1" : "3";
    this.autoDrive = !isPlayer;
  }

  setPose(x: number, z: number, yaw: number) {
    this.position.set(x, 0, z);
    this.yaw = yaw;
    this.syncMesh();
  }

  syncMesh() {
    this.mesh.position.set(this.position.x, 0, this.position.z);
    this.mesh.rotation.y = this.yaw;
  }

  get forward(): THREE.Vector3 {
    return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw));
  }

  update(dt: number, input: DriveInput) {
    if (this.crashed) {
      this.speed = THREE.MathUtils.damp(this.speed, 0, 6, dt);
      this.syncMesh();
      return;
    }

    const targetSteer = THREE.MathUtils.clamp(input.steer, -1, 1) * MAX_STEER;
    const returnSpeed = Math.abs(input.steer) < 0.05 ? STEER_SPEED * 8 : STEER_SPEED * 5;
    this.steer = THREE.MathUtils.damp(this.steer, targetSteer, returnSpeed, dt);
    if (Math.abs(input.steer) < 0.05 && Math.abs(this.steer) < 0.02) this.steer = 0;

    const absSpeed = Math.abs(this.speed);
    const stats = this.autoDrive
      ? { accel: 9, maxSpeed: 16, label: "D" }
      : GEAR_STATS[this.gear];

    if (this.gear === "P" && !this.autoDrive) {
      // Park: strong hold
      this.speed = THREE.MathUtils.damp(this.speed, 0, 14, dt);
    } else if (input.brake > 0.01 || input.handbrake) {
      const b = input.handbrake ? HANDBRAKE : BRAKE * input.brake;
      if (this.speed > 0) this.speed = Math.max(0, this.speed - b * dt);
      else if (this.speed < 0) this.speed = Math.min(0, this.speed + b * dt);
    } else if (input.throttle > 0.01 && stats.accel > 0) {
      const dir = this.autoDrive ? 1 : this.gear === "R" ? -1 : this.gear === "N" ? 0 : 1;
      if (dir !== 0) {
        // Torque falls off near gear top speed (redline feel)
        const limit = stats.maxSpeed;
        const ratio = Math.min(1, absSpeed / Math.max(0.1, limit));
        const torque = stats.accel * (1 - ratio * ratio) * input.throttle;
        this.speed += torque * dir * dt;
        // Soft clamp to gear max
        if (dir > 0 && this.speed > limit) {
          this.speed = THREE.MathUtils.damp(this.speed, limit, 4, dt);
        }
        if (dir < 0 && this.speed < -limit) {
          this.speed = THREE.MathUtils.damp(this.speed, -limit, 4, dt);
        }
        if (this.isPlayer) {
          this.fuel = 100;
        }
      }
    } else {
      // Coast — slow natural slowdown like a real car (no sudden stop)
      if (this.speed > 0.05) {
        this.speed = Math.max(0, this.speed - ROLLING_RESIST * dt);
      } else if (this.speed < -0.05) {
        this.speed = Math.min(0, this.speed + ROLLING_RESIST * dt);
      } else {
        this.speed = 0;
      }
    }

    // Neutral: no engine power even if somehow throttling
    if (!this.autoDrive && this.gear === "N" && input.brake < 0.01 && !input.handbrake) {
      if (input.throttle > 0.01) {
        // engine revs but no drive — still just coast
        if (this.speed > 0.05) this.speed = Math.max(0, this.speed - ROLLING_RESIST * dt);
        else if (this.speed < -0.05) this.speed = Math.min(0, this.speed + ROLLING_RESIST * dt);
        else this.speed = 0;
      }
    }

    if (absSpeed > 0.12) {
      const turnFactor = THREE.MathUtils.clamp(0.55 + absSpeed / 18, 0.55, 1.25);
      // Stronger yaw response so Auto left/right is visible
      this.yaw += this.steer * turnFactor * Math.sign(this.speed || 1) * dt * 1.45;
    }

    const f = this.forward;
    this.position.x += f.x * this.speed * dt;
    this.position.z += f.z * this.speed * dt;
    spinWheels(this.mesh, this.speed, dt);
    this.syncMesh();

    this.signalTime += dt;
    if (this.isPlayer) {
      this.signalBrake = input.brake > 0.15 || input.handbrake;
      if (this.blinkOverride !== null) this.signalBlink = this.blinkOverride;
      else if (input.steer > 0.35) this.signalBlink = "left";
      else if (input.steer < -0.35) this.signalBlink = "right";
      else this.signalBlink = "none";
    }
    setVehicleSignals(this.mesh, {
      headlights: true,
      brake: this.signalBrake,
      blinkLeft: this.signalBlink === "left",
      blinkRight: this.signalBlink === "right",
      time: this.signalTime,
    });
  }

  speedKmh(): number {
    return Math.round(Math.abs(this.speed) * 3.6);
  }

  /** Loose AABB for buildings / broad-phase (not used for vehicle contact). */
  aabb() {
    const hx = this.width * 0.5;
    const hz = this.length * 0.5;
    const c = Math.abs(Math.cos(this.yaw));
    const s = Math.abs(Math.sin(this.yaw));
    const halfX = hx * c + hz * s;
    const halfZ = hx * s + hz * c;
    return {
      minX: this.position.x - halfX,
      maxX: this.position.x + halfX,
      minZ: this.position.z - halfZ,
      maxZ: this.position.z + halfZ,
    };
  }

  /**
   * True when any part of this body overlaps the other (oriented boxes = mesh footprint).
   * Matches visual contact — not oversized AABB, not tiny shrunk boxes.
   */
  touches(other: Vehicle): boolean {
    return orientedBodiesOverlap(
      this.position.x,
      this.position.z,
      this.yaw,
      this.width * 0.5,
      this.length * 0.5,
      other.position.x,
      other.position.z,
      other.yaw,
      other.width * 0.5,
      other.length * 0.5,
    );
  }

  /** True when a circle (pedestrian) overlaps this vehicle body. */
  touchesPoint(x: number, z: number, radius: number): boolean {
    const dx = x - this.position.x;
    const dz = z - this.position.z;
    const c = Math.cos(this.yaw);
    const s = Math.sin(this.yaw);
    // Local: forward = (s, c), right = (c, -s)
    const along = dx * s + dz * c;
    const lat = dx * c - dz * s;
    const halfL = this.length * 0.5 + radius;
    const halfW = this.width * 0.5 + radius;
    return Math.abs(along) <= halfL && Math.abs(lat) <= halfW;
  }
}

/** 2D OBB vs OBB (Separating Axis Theorem) — car body rectangles in XZ. */
export function orientedBodiesOverlap(
  ax: number,
  az: number,
  aYaw: number,
  aHalfW: number,
  aHalfL: number,
  bx: number,
  bz: number,
  bYaw: number,
  bHalfW: number,
  bHalfL: number,
): boolean {
  const dx = bx - ax;
  const dz = bz - az;
  const aS = Math.sin(aYaw);
  const aC = Math.cos(aYaw);
  const bS = Math.sin(bYaw);
  const bC = Math.cos(bYaw);
  // Axes: A forward, A right, B forward, B right
  const axes = [
    [aS, aC],
    [aC, -aS],
    [bS, bC],
    [bC, -bS],
  ];
  for (const [nx, nz] of axes) {
    const dist = Math.abs(dx * nx + dz * nz);
    const aExt =
      aHalfL * Math.abs(aS * nx + aC * nz) + aHalfW * Math.abs(aC * nx - aS * nz);
    const bExt =
      bHalfL * Math.abs(bS * nx + bC * nz) + bHalfW * Math.abs(bC * nx - bS * nz);
    if (dist > aExt + bExt + 1e-4) return false;
  }
  return true;
}

export function aabbHit(
  a: ReturnType<Vehicle["aabb"]>,
  b: ReturnType<Vehicle["aabb"]>,
): boolean {
  return a.minX < b.maxX && a.maxX > b.minX && a.minZ < b.maxZ && a.maxZ > b.minZ;
}
