import * as THREE from "three";
import { PED_COUNT, ROAD_WIDTH, ZEBRA_LENGTH, ZEBRA_START } from "./constants";
import {
  cityHalfSpan,
  cityMaxX,
  cityMaxZ,
  cityMinX,
  cityMinZ,
  getCityAxes,
} from "./cityGrid";
import type { CityWorld } from "./world";
import type { Vehicle } from "./vehicle";

/** Where pedestrians walk across: the middle of the zebra, measured from the junction centre */
const ZEBRA_MID = ZEBRA_START + ZEBRA_LENGTH / 2;
/** Pedestrians stop this far from a car body instead of walking into it */
const YIELD_R = 1.55;
/** Extra length along the zebra so a car already on the bars counts as occupying it */
const ZEBRA_OCCUPY_PAD = 1.8;
/** Max time a pedestrian waits at an uncontrolled crossing before stepping out */
const UNCONTROLLED_WAIT = 6;

const SKIN = [0xffdbac, 0xf1c27d, 0xe0ac69, 0xc68642, 0x8d5524, 0xffe0bd, 0xd4a574];
const SHIRT = [0x1565c0, 0xc62828, 0x2e7d32, 0x6a1b9a, 0xef6c00, 0xffffff, 0x37474f, 0xf9a825, 0x00838f, 0xe91e63];
const PANTS = [0x1a237e, 0x212121, 0x4e342e, 0x455a64, 0x3e2723, 0x263238];

export interface Pedestrian {
  mesh: THREE.Group;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  torso: THREE.Object3D;
  /** sidewalk = strolling, wait = standing at the kerb for a safe gap, cross = on the zebra */
  mode: "sidewalk" | "wait" | "cross";
  roadAxis: "x" | "z";
  roadPos: number;
  side: number;
  along: number;
  speed: number;
  facing: number;
  phase: number;
  crossProgress: number;
  crossDir: number;
  /** which arm of the junction the zebra is on (±1 along the road) */
  crossSide: number;
  waitTimer: number;
  /** seconds spent standing at the kerb */
  waitedFor: number;
  /** Will step out on green/yellow after a short wait (jaywalker) */
  impatient: boolean;
  jaywalkTried: boolean;
  jaywalkDelay: number;
  /** Walking along the sidewalk toward a zebra (never teleport) */
  seekZebra: boolean;
  targetAlong: number;
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function createPersonMesh(): {
  mesh: THREE.Group;
  leftLeg: THREE.Object3D;
  rightLeg: THREE.Object3D;
  leftArm: THREE.Object3D;
  rightArm: THREE.Object3D;
  torso: THREE.Object3D;
} {
  const mesh = new THREE.Group();
  const skinTone = pick(SKIN);
  const skin = new THREE.MeshStandardMaterial({ color: skinTone, roughness: 0.78 });
  const shirtCol = pick(SHIRT);
  const shirt = new THREE.MeshStandardMaterial({ color: shirtCol, roughness: 0.75 });
  const pants = new THREE.MeshStandardMaterial({ color: pick(PANTS), roughness: 0.82 });
  const shoe = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.9 });
  const hair = new THREE.MeshStandardMaterial({
    color: pick([0x1a1a1a, 0x4e342e, 0x6d4c41, 0x3e2723, 0xffe082, 0xeeeeee, 0x5d4037]),
    roughness: 0.88,
  });

  const scale = 0.9 + Math.random() * 0.18;
  const style = Math.random();

  const shadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.22, 12),
    new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.02;
  mesh.add(shadow);

  const hips = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.18), pants);
  hips.position.y = 0.88;
  hips.castShadow = true;
  mesh.add(hips);

  const torso = new THREE.Group();
  torso.position.y = 1.12;
  const chest = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 0.22), shirt);
  chest.position.y = 0.08;
  chest.castShadow = true;
  torso.add(chest);
  const waist = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.14, 0.2), shirt);
  waist.position.y = -0.18;
  torso.add(waist);
  const collar = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.06, 0.18), shirt);
  collar.position.y = 0.28;
  torso.add(collar);
  mesh.add(torso);

  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.07, 0.1, 8), skin);
  neck.position.y = 1.48;
  mesh.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.155, 12, 10), skin);
  head.position.y = 1.62;
  head.scale.set(1, 1.08, 0.95);
  head.castShadow = true;
  mesh.add(head);

  const eyeMat = new THREE.MeshBasicMaterial({ color: 0x222222 });
  const eyeL = new THREE.Mesh(new THREE.SphereGeometry(0.025, 6, 6), eyeMat);
  eyeL.position.set(-0.05, 1.64, 0.13);
  mesh.add(eyeL);
  const eyeR = eyeL.clone();
  eyeR.position.x = 0.05;
  mesh.add(eyeR);

  if (style < 0.55) {
    const hairCap = new THREE.Mesh(new THREE.SphereGeometry(0.165, 10, 8), hair);
    hairCap.position.y = 1.68;
    hairCap.scale.set(1.05, 0.72, 1.05);
    mesh.add(hairCap);
  } else if (style < 0.8) {
    const bun = new THREE.Mesh(new THREE.SphereGeometry(0.08, 8, 6), hair);
    bun.position.set(0, 1.78, -0.02);
    mesh.add(bun);
    const top = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), hair);
    top.position.y = 1.68;
    top.scale.set(1.02, 0.55, 1.02);
    mesh.add(top);
  } else {
    const crop = new THREE.Mesh(new THREE.SphereGeometry(0.16, 10, 8), hair);
    crop.position.y = 1.7;
    crop.scale.set(1, 0.45, 1);
    mesh.add(crop);
  }

  if (Math.random() < 0.35) {
    const bag = new THREE.Mesh(
      new THREE.BoxGeometry(0.28, 0.32, 0.12),
      new THREE.MeshStandardMaterial({ color: pick([0x5d4037, 0x1565c0, 0x37474f]), roughness: 0.85 }),
    );
    bag.position.set(0, 1.2, -0.18);
    bag.castShadow = true;
    mesh.add(bag);
  }

  const makeLimb = (w: number, h: number, mat: THREE.Material, pivotY: number) => {
    const pivot = new THREE.Group();
    pivot.position.y = pivotY;
    const limb = new THREE.Mesh(new THREE.CapsuleGeometry(w * 0.45, Math.max(0.05, h - w), 4, 8), mat);
    limb.position.y = -h / 2;
    limb.castShadow = true;
    pivot.add(limb);
    return { pivot, limbLen: h };
  };

  const leftLeg = makeLimb(0.11, 0.58, pants, 0.86);
  leftLeg.pivot.position.x = -0.09;
  const leftShoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.24), shoe);
  leftShoe.position.set(0, -0.6, 0.05);
  leftLeg.pivot.add(leftShoe);
  mesh.add(leftLeg.pivot);

  const rightLeg = makeLimb(0.11, 0.58, pants, 0.86);
  rightLeg.pivot.position.x = 0.09;
  const rightShoe = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.07, 0.24), shoe);
  rightShoe.position.set(0, -0.6, 0.05);
  rightLeg.pivot.add(rightShoe);
  mesh.add(rightLeg.pivot);

  const leftArm = makeLimb(0.08, 0.48, shirt, 1.38);
  leftArm.pivot.position.x = -0.22;
  const leftHand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skin);
  leftHand.position.y = -0.5;
  leftArm.pivot.add(leftHand);
  mesh.add(leftArm.pivot);

  const rightArm = makeLimb(0.08, 0.48, shirt, 1.38);
  rightArm.pivot.position.x = 0.22;
  const rightHand = new THREE.Mesh(new THREE.SphereGeometry(0.055, 8, 6), skin);
  rightHand.position.y = -0.5;
  rightArm.pivot.add(rightHand);
  mesh.add(rightArm.pivot);

  mesh.scale.setScalar(scale);
  return {
    mesh,
    leftLeg: leftLeg.pivot,
    rightLeg: rightLeg.pivot,
    leftArm: leftArm.pivot,
    rightArm: rightArm.pivot,
    torso,
  };
}

function snapToNearestJunctionAlong(roadAxis: "x" | "z", along: number): number {
  const coords = roadAxis === "z" ? getCityAxes().zs : getCityAxes().xs;
  let best = coords[0];
  let bestD = Infinity;
  for (const c of coords) {
    const d = Math.abs(c - along);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  return best;
}

export class PedestrianSystem {
  peds: Pedestrian[] = [];
  private half: number;
  private scene: THREE.Scene;
  private world: CityWorld | null;
  private count: number;
  private blockers: Vehicle[] = [];

  constructor(scene: THREE.Scene, count = PED_COUNT, world: CityWorld | null = null) {
    this.scene = scene;
    this.world = world;
    this.count = count;
    this.half = cityHalfSpan();
    for (let i = 0; i < count; i++) this.spawn();
  }

  private crossingJunction(ped: Pedestrian): { x: number; z: number } {
    const crossAlong = snapToNearestJunctionAlong(ped.roadAxis, ped.along);
    return ped.roadAxis === "z" ? { x: ped.roadPos, z: crossAlong } : { x: crossAlong, z: ped.roadPos };
  }

  private crossSpeed(ped: Pedestrian): number {
    return 1.7 + ped.speed * 0.55;
  }

  private canCross(ped: Pedestrian): boolean {
    if (this.carOnZebra(ped)) return false;
    const intoRoad = ped.side < 0 ? 0.2 : 0.8;
    if (this.pathBlocked(ped, intoRoad, YIELD_R)) return false;
    if (!this.world) return ped.waitedFor > 1.0;
    const j = this.crossingJunction(ped);
    const light = this.world.lightAt(j.x, j.z);
    if (!light) return ped.waitedFor > UNCONTROLLED_WAIT * 0.3;
    const axis: "ns" | "ew" = ped.roadAxis === "z" ? "ns" : "ew";
    const sig = this.world.signalFor(axis, light);
    const redLeft = this.world.redRemaining(axis, light);

    if (ped.impatient) {
      if (sig === "RED" && redLeft >= 2.2) return true;
      if (ped.waitedFor > 1.2 + ped.jaywalkDelay) {
        ped.jaywalkTried = true;
        return true;
      }
      return false;
    }

    if (sig === "RED") return redLeft >= 1.1 || ped.waitedFor > 0.5;
    return false;
  }

  private spawn() {
    const parts = createPersonMesh();
    const { xs, zs } = getCityAxes();
    const roadAxis: "x" | "z" = Math.random() < 0.5 ? "z" : "x";
    const roadPos =
      roadAxis === "z"
        ? xs[Math.floor(Math.random() * xs.length)]
        : zs[Math.floor(Math.random() * zs.length)];
    const side = Math.random() < 0.5 ? -1 : 1;
    const amin = roadAxis === "z" ? cityMinZ() : cityMinX();
    const amax = roadAxis === "z" ? cityMaxZ() : cityMaxX();
    const along = amin + Math.random() * (amax - amin) * 0.9;
    const facing = Math.random() < 0.5 ? 1 : -1;
    const impatient = Math.random() < 0.24;

    const crossDir = side < 0 ? 1 : -1;
    const ped: Pedestrian = {
      ...parts,
      mode: "sidewalk",
      roadAxis,
      roadPos,
      side,
      along,
      speed: 1.05 + Math.random() * 0.75,
      facing,
      phase: Math.random() * Math.PI * 2,
      crossProgress: side < 0 ? 0 : 1,
      crossDir,
      crossSide: Math.random() < 0.5 ? 1 : -1,
      waitTimer: 3 + Math.random() * 8,
      waitedFor: 0,
      impatient,
      jaywalkTried: false,
      jaywalkDelay: 0.4 + Math.random() * 3.2,
      seekZebra: false,
      targetAlong: along,
    };

    this.place(ped);
    this.scene.add(ped.mesh);
    this.peds.push(ped);
  }

  private sidewalkOffset() {
    return ROAD_WIDTH / 2 + 1.6;
  }

  private crossWorld(ped: Pedestrian, progress: number): { x: number; z: number } {
    const off = this.sidewalkOffset();
    const lat = -off + 2 * off * progress;
    if (ped.roadAxis === "z") return { x: ped.roadPos + lat, z: ped.along };
    return { x: ped.along, z: ped.roadPos + lat };
  }

  private blockedAt(x: number, z: number, radius = YIELD_R): boolean {
    for (const v of this.blockers) {
      if (v.touchesPoint(x, z, radius)) return true;
    }
    return false;
  }

  private pathBlocked(ped: Pedestrian, progress: number, radius = YIELD_R): boolean {
    const p = this.crossWorld(ped, progress);
    return this.blockedAt(p.x, p.z, radius);
  }

  /** True when a vehicle is already sitting on this zebra (car got there first). */
  private carOnZebra(ped: Pedestrian): boolean {
    const jAlong = snapToNearestJunctionAlong(ped.roadAxis, ped.along);
    const zebraAlong = jAlong + (ped.crossSide || Math.sign(ped.along - jAlong) || 1) * ZEBRA_MID;
    const alongSpan = ZEBRA_LENGTH * 0.55 + ZEBRA_OCCUPY_PAD;
    for (const v of this.blockers) {
      const vx = v.position.x;
      const vz = v.position.z;
      let dAlong: number;
      let dLat: number;
      if (ped.roadAxis === "z") {
        dAlong = Math.abs(vz - zebraAlong);
        dLat = Math.abs(vx - ped.roadPos);
      } else {
        dAlong = Math.abs(vx - zebraAlong);
        dLat = Math.abs(vz - ped.roadPos);
      }
      if (dAlong < alongSpan + v.length * 0.45 && dLat < ROAD_WIDTH / 2 + v.width * 0.45) return true;
    }
    return false;
  }

  private place(ped: Pedestrian) {
    const off = this.sidewalkOffset();
    if (ped.mode === "sidewalk" || ped.mode === "wait") {
      // Waiters stay on the kerb — never snap into the carriageway
      if (ped.roadAxis === "z") {
        ped.mesh.position.set(ped.roadPos + ped.side * off, 0, ped.along);
        if (ped.mode === "wait") {
          ped.mesh.rotation.y = ped.crossDir > 0 ? Math.PI / 2 : -Math.PI / 2;
        } else {
          ped.mesh.rotation.y = ped.facing > 0 ? 0 : Math.PI;
        }
      } else {
        ped.mesh.position.set(ped.along, 0, ped.roadPos + ped.side * off);
        if (ped.mode === "wait") {
          ped.mesh.rotation.y = ped.crossDir > 0 ? 0 : Math.PI;
        } else {
          ped.mesh.rotation.y = ped.facing > 0 ? Math.PI / 2 : -Math.PI / 2;
        }
      }
    } else {
      const lat = -off + 2 * off * ped.crossProgress;
      if (ped.roadAxis === "z") {
        ped.mesh.position.set(ped.roadPos + lat, 0, ped.along);
        ped.mesh.rotation.y = ped.crossDir > 0 ? Math.PI / 2 : -Math.PI / 2;
      } else {
        ped.mesh.position.set(ped.along, 0, ped.roadPos + lat);
        ped.mesh.rotation.y = ped.crossDir > 0 ? 0 : Math.PI;
      }
    }
  }

  isOnRoad(ped: Pedestrian): boolean {
    if (ped.mode !== "cross") return false;
    const off = this.sidewalkOffset();
    const lat = Math.abs(-off + 2 * off * ped.crossProgress);
    return lat < ROAD_WIDTH / 2 + 0.6;
  }

  update(dt: number, blockers: Vehicle[] = []) {
    this.half = cityHalfSpan();
    this.blockers = blockers;
    for (const ped of this.peds) {
      if (ped.mesh.userData.down) continue;

      const standing = ped.mode === "wait";
      ped.phase += dt * (standing ? 0.9 : ped.speed * (ped.mode === "cross" ? 6.5 : 5.2));
      const swing = standing ? 0 : Math.sin(ped.phase) * 0.5;
      ped.leftLeg.rotation.x = swing;
      ped.rightLeg.rotation.x = -swing;
      ped.leftArm.rotation.x = -swing * 0.65;
      ped.rightArm.rotation.x = swing * 0.65;
      ped.torso.position.y = 1.12 + Math.abs(Math.sin(ped.phase)) * (standing ? 0.006 : 0.02);
      ped.torso.rotation.y = standing ? Math.sin(ped.phase) * 0.08 : Math.sin(ped.phase * 0.5) * 0.04;

      if (ped.mode === "wait") {
        ped.waitedFor += dt;
        if (this.canCross(ped)) {
          ped.mode = "cross";
          ped.waitedFor = 0;
        } else if (ped.waitedFor > 28) {
          ped.mode = "sidewalk";
          ped.waitedFor = 0;
          ped.waitTimer = 2 + Math.random() * 4;
        }
        this.place(ped);
      } else if (ped.mode === "sidewalk") {
        if (ped.seekZebra) {
          const dir = Math.sign(ped.targetAlong - ped.along);
          if (dir !== 0) ped.facing = dir;
          ped.along += ped.facing * ped.speed * dt;
          if (Math.abs(ped.along - ped.targetAlong) < 0.45) {
            ped.along = ped.targetAlong;
            ped.seekZebra = false;
            ped.mode = "wait";
            ped.waitedFor = 0;
            ped.crossProgress = ped.side < 0 ? 0 : 1;
            ped.crossDir = ped.side < 0 ? 1 : -1;
          }
        } else {
          ped.along += ped.facing * ped.speed * dt;
          if (Math.abs(ped.along) > this.half + 20) {
            ped.facing *= -1;
            ped.along = THREE.MathUtils.clamp(ped.along, -this.half - 15, this.half + 15);
          }
          ped.waitTimer -= dt;
          if (ped.waitTimer <= 0) {
            const jAlong = snapToNearestJunctionAlong(ped.roadAxis, ped.along);
            const zebraAlong = jAlong + (Math.sign(ped.along - jAlong) || (Math.random() < 0.5 ? 1 : -1)) * ZEBRA_MID;
            const nearIntersect = Math.abs(ped.along - zebraAlong) < 14;
            if (nearIntersect && Math.random() < 0.55) {
              ped.seekZebra = true;
              ped.crossSide = Math.sign(zebraAlong - jAlong) || 1;
              ped.targetAlong = jAlong + ped.crossSide * ZEBRA_MID;
              ped.impatient = Math.random() < 0.24;
              ped.jaywalkTried = false;
              ped.jaywalkDelay = 0.4 + Math.random() * 3.2;
            }
            ped.waitTimer = 4 + Math.random() * 8;
          }
        }
        this.place(ped);
      } else {
        const rate = this.crossSpeed(ped) / (2 * this.sidewalkOffset());
        const next = ped.crossProgress + ped.crossDir * rate * dt;
        const carAhead = this.pathBlocked(ped, next, YIELD_R);
        if (carAhead) {
          if (this.pathBlocked(ped, ped.crossProgress, 0.55)) {
            ped.crossProgress -= ped.crossDir * rate * dt * 0.9;
          }
          const atKerb = ped.crossDir > 0 ? ped.crossProgress <= 0.08 : ped.crossProgress >= 0.92;
          if (atKerb) {
            ped.mode = "wait";
            ped.waitedFor = 0;
            ped.crossProgress = ped.side < 0 ? 0 : 1;
          }
        } else {
          ped.crossProgress = next;
        }
        if (ped.crossProgress >= 1 || ped.crossProgress <= 0) {
          ped.side = ped.crossProgress >= 1 ? 1 : -1;
          ped.mode = "sidewalk";
          ped.crossProgress = 0;
          ped.seekZebra = false;
          ped.facing = Math.random() < 0.5 ? 1 : -1;
          ped.waitTimer = 6 + Math.random() * 10;
        }
        this.place(ped);
      }
      ped.mesh.position.y = Math.abs(Math.sin(ped.phase)) * 0.025;
    }
  }

  /**
   * Fatal only if the car is driving into the person.
   * A pedestrian walking into a car already on the zebra is not a crash.
   */
  collidePlayer(player: Vehicle): boolean {
    for (const ped of this.peds) {
      if (ped.mesh.userData.down) continue;
      const p = ped.mesh.position;
      if (!player.touchesPoint(p.x, p.z, 0.28)) continue;
      const dx = p.x - player.position.x;
      const dz = p.z - player.position.z;
      const along = dx * Math.sin(player.yaw) + dz * Math.cos(player.yaw);
      const drivingInto = player.speed > 2.0 && along > 0 && along < player.length * 0.5 + 2.4;
      if (!drivingInto) continue;
      ped.mesh.userData.down = true;
      ped.mesh.rotation.z = Math.PI / 2;
      ped.mesh.position.y = 0.2;
      ped.speed = 0;
      return true;
    }
    return false;
  }

  reset() {
    for (const p of this.peds) this.scene.remove(p.mesh);
    this.peds = [];
    this.half = cityHalfSpan();
    for (let i = 0; i < this.count; i++) this.spawn();
  }
}
