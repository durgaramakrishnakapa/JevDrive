import * as THREE from "three";
import {
  BLOCK,
  CITY_BLOCKS,
  LANE_WIDTH,
  LIGHT_GREEN,
  LIGHT_GREEN_CROSS,
  LIGHT_GREEN_NORMAL,
  LIGHT_RED,
  LIGHT_SETBACK,
  LIGHT_YELLOW,
  ROAD_WIDTH,
  STOP_LINE_SETBACK,
  ZEBRA_BAR,
  ZEBRA_BARS,
  ZEBRA_GAP,
  ZEBRA_START,
} from "./constants";
import {
  cityMaxX,
  cityMaxZ,
  cityMinX,
  cityMinZ,
  makeIrregularAxes,
  setActiveCityGrid,
} from "./cityGrid";
import { createPlaceAreaMesh, createPlaceLandmark } from "./placeVisuals";
import {
  PLACE_CATALOG,
  PLACE_SEP_M,
  distToPlace,
  inPlace,
  makeCityPlace,
  missionWeight,
  pickWeighted,
  shuffleInPlace,
  type CityPlace,
} from "./places";
import { keepLeftLateralSign, laneCenter, travelForward, travelLeft, type TravelDir } from "./lanes";
import {
  asphaltMaterial,
  buildingMaterial,
  grassMaterial,
  sidewalkMaterial,
} from "./textures";

export interface LightLamp {
  mat: THREE.MeshBasicMaterial;
  mesh: THREE.Mesh;
}

export interface LightState {
  x: number;
  z: number;
  /** 0 NS green, 1 NS yellow, 2 EW green, 3 EW yellow */
  phase: number;
  timer: number;
  group: THREE.Group;
  nsLamps: LightLamp[];
  ewLamps: LightLamp[];
  /** Per-approach lamps so we can green only one road at a time */
  armLamps: Partial<Record<keyof JunctionArms, LightLamp[]>>;
  arms: { n: boolean; s: boolean; e: boolean; w: boolean };
  /**
   * While set, ONLY this approach may move (others stay red) — used during
   * the player's red so one random other road gets a short green.
   */
  exclusiveArm: keyof JunctionArms | null;
  /** Countdown readouts facing each approach */
  timers: {
    mesh: THREE.Mesh;
    mat: THREE.MeshBasicMaterial;
    canvas: HTMLCanvasElement;
    ctx: CanvasRenderingContext2D;
    facing: "ns" | "ew";
    arm: keyof JunctionArms;
  }[];
}

export type JunctionArms = { n: boolean; s: boolean; e: boolean; w: boolean };

/** Which approach arm a vehicle on this road/travel is coming from */
export function approachArmFromTravel(roadAxis: "x" | "z", travelDir: 1 | -1): keyof JunctionArms {
  if (roadAxis === "z") return travelDir > 0 ? "s" : "n";
  return travelDir > 0 ? "w" : "e";
}

export function axisOfArm(arm: keyof JunctionArms): "ns" | "ew" {
  return arm === "n" || arm === "s" ? "ns" : "ew";
}

export class CityWorld {
  group = new THREE.Group();
  roads: { axis: "x" | "z"; pos: number }[] = [];
  /** Irregular X road line positions (west → east) */
  xs: number[] = [];
  /** Irregular Z road line positions (south → north) */
  zs: number[] = [];
  lights: LightState[] = [];
  /** Junction centers with which arms are open (for AI turns / T-junctions) */
  junctions: { x: number; z: number; arms: JunctionArms }[] = [];
  destination = new THREE.Vector3();
  destinationMarker: THREE.Group = new THREE.Group();
  destinationPlace: CityPlace | null = null;
  places: CityPlace[] = [];
  private placeAreaMeshes: THREE.Group[] = [];
  buildingBoxes: { minX: number; maxX: number; minZ: number; maxZ: number }[] = [];
  /** Accumulated time for yellow lamp blink (2 Hz) */
  private lightTime = 0;

  constructor() {
    this.build();
  }

  private build() {
    // Clumsy uneven grid: short alleys + long boulevards (4th gear room)
    this.xs = makeIrregularAxes(CITY_BLOCKS);
    this.zs = makeIrregularAxes(CITY_BLOCKS);
    setActiveCityGrid(this.xs, this.zs);

    const minX = cityMinX();
    const maxX = cityMaxX();
    const minZ = cityMinZ();
    const maxZ = cityMaxZ();
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;

    const grass = new THREE.Mesh(
      new THREE.PlaneGeometry(spanX + 120, spanZ + 120),
      grassMaterial(),
    );
    grass.rotation.x = -Math.PI / 2;
    grass.position.set((minX + maxX) / 2, 0, (minZ + maxZ) / 2);
    grass.receiveShadow = true;
    this.group.add(grass);

    const asphalt = asphaltMaterial();
    const sidewalk = sidewalkMaterial();
    const curbMat = new THREE.MeshStandardMaterial({
      color: 0xc5cad1,
      roughness: 0.7,
      metalness: 0.05,
    });
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xf5f5f5 });
    const yellowMat = new THREE.MeshBasicMaterial({ color: 0xffc107 });

    // NS roads (constant x)
    for (let i = 0; i <= CITY_BLOCKS; i++) {
      const p = this.xs[i];
      this.roads.push({ axis: "z", pos: p });

      const roadZ = new THREE.Mesh(
        new THREE.PlaneGeometry(ROAD_WIDTH, spanZ + ROAD_WIDTH),
        asphalt,
      );
      roadZ.rotation.x = -Math.PI / 2;
      roadZ.position.set(p, 0.02, (minZ + maxZ) / 2);
      roadZ.receiveShadow = true;
      this.group.add(roadZ);

      for (const side of [-1, 1]) {
        const sw = new THREE.Mesh(new THREE.PlaneGeometry(2.2, spanZ), sidewalk);
        sw.rotation.x = -Math.PI / 2;
        sw.position.set(p + side * (ROAD_WIDTH / 2 + 1.1), 0.035, (minZ + maxZ) / 2);
        sw.receiveShadow = true;
        this.group.add(sw);

        const curb = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.18, spanZ), curbMat);
        curb.position.set(p + side * (ROAD_WIDTH / 2 + 0.12), 0.09, (minZ + maxZ) / 2);
        curb.castShadow = true;
        this.group.add(curb);
      }

      this.addLaneMarkings(p, "z", lineMat, yellowMat);
    }

    // EW roads (constant z)
    for (let j = 0; j <= CITY_BLOCKS; j++) {
      const p = this.zs[j];
      this.roads.push({ axis: "x", pos: p });

      const roadX = new THREE.Mesh(
        new THREE.PlaneGeometry(spanX + ROAD_WIDTH, ROAD_WIDTH),
        asphalt,
      );
      roadX.rotation.x = -Math.PI / 2;
      roadX.position.set((minX + maxX) / 2, 0.021, p);
      roadX.receiveShadow = true;
      this.group.add(roadX);

      for (const side of [-1, 1]) {
        const swX = new THREE.Mesh(new THREE.PlaneGeometry(spanX, 2.2), sidewalk);
        swX.rotation.x = -Math.PI / 2;
        swX.position.set((minX + maxX) / 2, 0.036, p + side * (ROAD_WIDTH / 2 + 1.1));
        this.group.add(swX);
      }

      this.addLaneMarkings(p, "x", lineMat, yellowMat);
    }

    const startI = Math.min(2, CITY_BLOCKS);
    const startX = this.xs[startI];
    const startZ = this.zs[0] + (this.zs[1] - this.zs[0]) * 0.35;
    this.pickPlaces(startX, startZ);

    // Buildings in each irregular cell
    const facadeColors = [0xd4c8b0, 0xc5d0d8, 0xe8dcc8, 0xb8c4c0, 0xd8c8c0, 0xa8c8a0, 0xc8b8a0, 0xb0c0d0];
    for (let bx = 0; bx < CITY_BLOCKS; bx++) {
      for (let bz = 0; bz < CITY_BLOCKS; bz++) {
        const x0 = this.xs[bx];
        const x1 = this.xs[bx + 1];
        const z0 = this.zs[bz];
        const z1 = this.zs[bz + 1];
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const margin = ROAD_WIDTH / 2 + 4.5;
        const areaW = x1 - x0 - margin * 2;
        const areaD = z1 - z0 - margin * 2;
        if (areaW < 8 || areaD < 8) continue;

        const named = this.places.find((p) => p.bx === bx && p.bz === bz);
        if (named) {
          const landmark = createPlaceLandmark(named);
          this.group.add(landmark.group);
          this.buildingBoxes.push(...landmark.boxes);
          continue;
        }
        const count = 2 + Math.floor(Math.random() * 4);
        for (let n = 0; n < count; n++) {
          const w = Math.min(areaW * 0.45, 6 + Math.random() * 11);
          const d = Math.min(areaD * 0.45, 6 + Math.random() * 11);
          const floors = 2 + Math.floor(Math.random() * 8);
          const h = floors * 3.2;
          const ox = (Math.random() - 0.5) * (areaW - w);
          const oz = (Math.random() - 0.5) * (areaD - d);
          const baseColor = facadeColors[Math.floor(Math.random() * facadeColors.length)];
          const mat = buildingMaterial(Math.random());
          mat.color.setHex(baseColor);
          const b = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
          b.position.set(cx + ox, h / 2, cz + oz);
          b.castShadow = true;
          b.receiveShadow = true;
          this.group.add(b);
          this.buildingBoxes.push({
            minX: cx + ox - w / 2,
            maxX: cx + ox + w / 2,
            minZ: cz + oz - d / 2,
            maxZ: cz + oz + d / 2,
          });

          // Flat roof ledge
          const roof = new THREE.Mesh(
            new THREE.BoxGeometry(w + 0.4, 0.35, d + 0.4),
            new THREE.MeshStandardMaterial({ color: 0x5a6068, roughness: 0.9 }),
          );
          roof.position.set(cx + ox, h + 0.1, cz + oz);
          this.group.add(roof);
        }

        // A few trees in larger cells
        if (areaW > 40 && areaD > 40 && Math.random() < 0.55) {
          this.addTree(
            cx + (Math.random() - 0.5) * areaW * 0.7,
            cz + (Math.random() - 0.5) * areaD * 0.7,
          );
        }
      }
    }

    // Traffic lights on the irregular grid
    for (let i = 0; i <= CITY_BLOCKS; i++) {
      for (let j = 0; j <= CITY_BLOCKS; j++) {
        const x = this.xs[i];
        const z = this.zs[j];
        const arms = this.makeJunctionArms(i, j);
        this.junctions.push({ x, z, arms });
        this.addTrafficLight(x, z, (i + j) % 2, arms);
      }
    }

    this.placeDestinationMarker();

    this.addAllZebraCrossings();

    // Street lamps along mid-block segments
    const lampMat = new THREE.MeshStandardMaterial({ color: 0x333333 });
    const bulbMat = new THREE.MeshStandardMaterial({
      color: 0xfff3c4,
      emissive: 0xffe082,
      emissiveIntensity: 0.8,
    });
    for (let i = 0; i <= CITY_BLOCKS; i++) {
      const px = this.xs[i];
      for (let k = 0; k < CITY_BLOCKS; k++) {
        const along = (this.zs[k] + this.zs[k + 1]) / 2;
        this.addStreetLamp(px + ROAD_WIDTH / 2 + 1.8, along, lampMat, bulbMat);
      }
    }
    for (let j = 0; j <= CITY_BLOCKS; j++) {
      const pz = this.zs[j];
      for (let k = 0; k < CITY_BLOCKS; k++) {
        const along = (this.xs[k] + this.xs[k + 1]) / 2;
        this.addStreetLamp(along, pz + ROAD_WIDTH / 2 + 1.8, lampMat, bulbMat);
      }
    }

  }

  private pickPlaces(spawnX: number, spawnZ: number) {
    const catalog = shuffleInPlace([...PLACE_CATALOG]);
    type Cell = { bx: number; bz: number; x0: number; x1: number; z0: number; z1: number; cx: number; cz: number; d: number; area: number };
    const cells: Cell[] = [];
    for (let bx = 0; bx < CITY_BLOCKS; bx++) {
      for (let bz = 0; bz < CITY_BLOCKS; bz++) {
        const x0 = this.xs[bx];
        const x1 = this.xs[bx + 1];
        const z0 = this.zs[bz];
        const z1 = this.zs[bz + 1];
        if (x1 - x0 < 32 || z1 - z0 < 32) continue;
        const cx = (x0 + x1) / 2;
        const cz = (z0 + z1) / 2;
        const d = Math.hypot(cx - spawnX, cz - spawnZ);
        cells.push({ bx, bz, x0, x1, z0, z1, cx, cz, d, area: (x1 - x0) * (z1 - z0) });
      }
    }
    const far = cells.filter((c) => c.d >= 180);
    const destDef =
      pickWeighted(
        catalog.filter((d) => d.kind !== "hospital"),
        (d) => missionWeight(d.kind),
      ) ?? catalog.find((d) => d.kind !== "hospital") ?? catalog[0];
    const destPool = far.length ? far : cells;
    destPool.sort((a, b) =>
      destDef.kind === "stadium" || destDef.kind === "itpark"
        ? b.area - a.area
        : Math.abs(a.d - 320) - Math.abs(b.d - 320),
    );
    const destCell = destPool[0];
    if (!destCell) return;

    const placed: CityPlace[] = [];
    const take = (def: (typeof catalog)[0], cell: Cell) => {
      const p = makeCityPlace(def, cell.bx, cell.bz, cell.x0, cell.x1, cell.z0, cell.z1, spawnX, spawnZ);
      placed.push(p);
      return p;
    };
    const farEnough = (cell: Cell) =>
      placed.every((p) => Math.hypot(cell.cx - p.cx, cell.cz - p.cz) >= PLACE_SEP_M) &&
      Math.hypot(cell.cx - spawnX, cell.cz - spawnZ) >= PLACE_SEP_M;

    this.destinationPlace = take(destDef, destCell);
    this.destination.set(this.destinationPlace.gateX, 0, this.destinationPlace.gateZ);

    const rest = catalog.filter((d) => d !== destDef);
    rest.sort((a, b) => {
      const need = (k: string) => (k === "stadium" || k === "itpark" || k === "college" ? 1 : 0);
      return need(b.kind) - need(a.kind);
    });
    const leftover = cells
      .filter((c) => !(c.bx === destCell.bx && c.bz === destCell.bz))
      .sort((a, b) => b.area - a.area);
    for (const def of rest) {
      const cell = leftover.find((c) => farEnough(c));
      if (!cell) continue;
      leftover.splice(leftover.indexOf(cell), 1);
      take(def, cell);
    }
    this.places = placed;
  }

  /** Pick a new mission among placed areas. Hospital is never the goal. */
  rollMission() {
    const pool = this.places.filter((p) => p.kind !== "hospital");
    if (!pool.length) return;
    const next = pickWeighted(pool, (p) => missionWeight(p.kind));
    this.destinationPlace = next;
    this.destination.set(next.gateX, 0, next.gateZ);
    this.placeDestinationMarker();
  }

  private placeDestinationMarker() {
    for (const g of this.placeAreaMeshes) this.group.remove(g);
    this.placeAreaMeshes = [];
    if (!this.destinationPlace) return;
    this.destinationMarker = createPlaceAreaMesh(this.destinationPlace, true);
    this.group.add(this.destinationMarker);
    this.placeAreaMeshes.push(this.destinationMarker);
    for (const p of this.places) {
      if (p === this.destinationPlace) continue;
      const g = createPlaceAreaMesh(p, false);
      this.group.add(g);
      this.placeAreaMeshes.push(g);
    }
  }

  inDestination(x: number, z: number): boolean {
    return !!this.destinationPlace && inPlace(this.destinationPlace, x, z);
  }

  distToDestination(x: number, z: number): number {
    return this.destinationPlace ? distToPlace(this.destinationPlace, x, z) : this.destination.distanceTo(new THREE.Vector3(x, 0, z));
  }

  private addAllZebraCrossings() {
    const white = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.9,
      metalness: 0,
    });
    const stopLine = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.85,
    });
    const asphaltPatch = new THREE.MeshStandardMaterial({
      color: 0x3a3e45,
      roughness: 0.95,
      metalness: 0.04,
    });
    const sidewalkCap = new THREE.MeshStandardMaterial({
      color: 0x9aa3ad,
      roughness: 0.92,
      metalness: 0.05,
    });

    for (let i = 0; i <= CITY_BLOCKS; i++) {
      for (let j = 0; j <= CITY_BLOCKS; j++) {
        const ix = this.xs[i];
        const iz = this.zs[j];
        const arms = this.junctionAt(ix, iz)?.arms ?? { n: true, s: true, e: true, w: true };

        const patch = new THREE.Mesh(
          new THREE.PlaneGeometry(ROAD_WIDTH + 0.6, ROAD_WIDTH + 0.6),
          asphaltPatch,
        );
        patch.rotation.x = -Math.PI / 2;
        patch.position.set(ix, 0.048, iz);
        patch.receiveShadow = true;
        this.group.add(patch);

        if (arms.s) this.addZebraApproach(ix, iz, "z", -1, white, stopLine);
        else this.addTJunctionCap(ix, iz, "s", sidewalkCap);
        if (arms.n) this.addZebraApproach(ix, iz, "z", 1, white, stopLine);
        else this.addTJunctionCap(ix, iz, "n", sidewalkCap);
        if (arms.w) this.addZebraApproach(ix, iz, "x", -1, white, stopLine);
        else this.addTJunctionCap(ix, iz, "w", sidewalkCap);
        if (arms.e) this.addZebraApproach(ix, iz, "x", 1, white, stopLine);
        else this.addTJunctionCap(ix, iz, "e", sidewalkCap);
      }
    }
  }

  /** Close one arm visually so the crossing reads as a T */
  private addTJunctionCap(
    ix: number,
    iz: number,
    arm: "n" | "s" | "e" | "w",
    mat: THREE.Material,
  ) {
    const depth = ROAD_WIDTH * 0.55;
    const width = ROAD_WIDTH + 1.2;
    const mesh =
      arm === "n" || arm === "s"
        ? new THREE.Mesh(new THREE.PlaneGeometry(width, depth), mat)
        : new THREE.Mesh(new THREE.PlaneGeometry(depth, width), mat);
    mesh.rotation.x = -Math.PI / 2;
    const off = ROAD_WIDTH / 2 + depth / 2 - 0.2;
    if (arm === "n") mesh.position.set(ix, 0.052, iz + off);
    else if (arm === "s") mesh.position.set(ix, 0.052, iz - off);
    else if (arm === "e") mesh.position.set(ix + off, 0.052, iz);
    else mesh.position.set(ix - off, 0.052, iz);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private makeJunctionArms(i: number, j: number): JunctionArms {
    const arms: JunctionArms = { n: true, s: true, e: true, w: true };
    // Edge of city: naturally fewer arms
    if (j === CITY_BLOCKS) arms.n = false;
    if (j === 0) arms.s = false;
    if (i === CITY_BLOCKS) arms.e = false;
    if (i === 0) arms.w = false;

    // Interior: ~30% become T-junctions (close one extra arm)
    const interior = i > 0 && i < CITY_BLOCKS && j > 0 && j < CITY_BLOCKS;
    if (interior && (i * 7 + j * 13) % 10 < 3) {
      const open = (["n", "s", "e", "w"] as const).filter((a) => arms[a]);
      if (open.length === 4) {
        const close = open[(i + j) % 4];
        arms[close] = false;
      }
    }
    return arms;
  }

  junctionAt(x: number, z: number): { x: number; z: number; arms: JunctionArms } | null {
    let best: { x: number; z: number; arms: JunctionArms } | null = null;
    let bestD = Infinity;
    for (const j of this.junctions) {
      const d = Math.hypot(j.x - x, j.z - z);
      if (d < bestD) {
        bestD = d;
        best = j;
      }
    }
    return bestD < BLOCK * 0.45 ? best : null;
  }

  /**
   * Zebra just before the junction. Bars run curb-to-curb (across the road),
   * spaced along the approach — never stretched into the intersection.
   */
  private addZebraApproach(
    ix: number,
    iz: number,
    roadAxis: "x" | "z",
    dir: number,
    white: THREE.Material,
    stopLine: THREE.Material,
  ) {
    const bars = ZEBRA_BARS;
    const barThick = ZEBRA_BAR;
    const barGap = ZEBRA_GAP;
    // Zebra hugs the junction box; the stop line is behind it (see STOP_LINE_SETBACK)
    const start = ZEBRA_START;

    for (let s = 0; s < bars; s++) {
      const along = start + s * (barThick + barGap) + barThick / 2;
      if (roadAxis === "z") {
        // Traffic along Z; bars long in X (across road)
        const stripe = new THREE.Mesh(
          new THREE.PlaneGeometry(ROAD_WIDTH * 0.88, barThick),
          white,
        );
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(ix, 0.056, iz + dir * along);
        stripe.receiveShadow = true;
        this.group.add(stripe);
      } else {
        const stripe = new THREE.Mesh(
          new THREE.PlaneGeometry(barThick, ROAD_WIDTH * 0.88),
          white,
        );
        stripe.rotation.x = -Math.PI / 2;
        stripe.position.set(ix + dir * along, 0.056, iz);
        stripe.receiveShadow = true;
        this.group.add(stripe);
      }
    }

    // Stop line BEHIND the zebra (vehicles wait before the crossing, never on it)
    const stopAt = STOP_LINE_SETBACK;
    if (roadAxis === "z") {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(ROAD_WIDTH * 0.92, 0.22), stopLine);
      line.rotation.x = -Math.PI / 2;
      line.position.set(ix, 0.057, iz + dir * stopAt);
      this.group.add(line);
    } else {
      const line = new THREE.Mesh(new THREE.PlaneGeometry(0.22, ROAD_WIDTH * 0.92), stopLine);
      line.rotation.x = -Math.PI / 2;
      line.position.set(ix + dir * stopAt, 0.057, iz);
      this.group.add(line);
    }
  }

  /**
   * White chevron on the keep-left half — tip points exactly in travelDir.
   * Built in XZ (no ShapeGeometry Euler tip bug).
   */
  private addKeepLeftArrow(
    axis: "x" | "z",
    roadPos: number,
    along: number,
    travelDir: TravelDir,
    mat: THREE.Material,
  ) {
    const lat = roadPos + keepLeftLateralSign(axis, travelDir) * LANE_WIDTH * 0.55;
    const f = travelForward(axis, travelDir);
    const L = travelLeft(axis, travelDir);

    // Arrow outline in the ground plane: tip along +forward, width along ±left
    const tip = 1.15;
    const neck = 0.3;
    const halfHead = 0.48;
    const halfShaft = 0.16;
    const back = 1.05;
    const y = 0;
    const pt = (alongF: number, alongL: number): [number, number, number] => [
      f.x * alongF + L.x * alongL,
      y,
      f.z * alongF + L.z * alongL,
    ];
    const tipP = pt(tip, 0);
    const hr = pt(neck, halfHead);
    const hl = pt(neck, -halfHead);
    const sr = pt(neck, halfShaft);
    const sl = pt(neck, -halfShaft);
    const br = pt(-back, halfShaft);
    const bl = pt(-back, -halfShaft);

    const positions = new Float32Array([
      // head
      ...tipP, ...hr, ...hl,
      // shaft
      ...sr, ...br, ...bl,
      ...sr, ...bl, ...sl,
    ]);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geo.computeVertexNormals();

    const arrow = new THREE.Mesh(geo, mat);
    if (axis === "z") arrow.position.set(lat, 0.047, along);
    else arrow.position.set(along, 0.047, lat);
    this.group.add(arrow);
  }

  private addStreetLamp(
    x: number,
    z: number,
    poleMat: THREE.Material,
    bulbMat: THREE.Material,
  ) {
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.1, 5.2, 8), poleMat);
    pole.position.set(x, 2.6, z);
    pole.castShadow = true;
    this.group.add(pole);
    const arm = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.08, 0.08), poleMat);
    arm.position.set(x - 0.55, 5.1, z);
    this.group.add(arm);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.18, 10, 8), bulbMat);
    bulb.position.set(x - 1.1, 5.0, z);
    this.group.add(bulb);
  }

  private addLaneMarkings(
    pos: number,
    axis: "x" | "z",
    lineMat: THREE.Material,
    yellowMat: THREE.Material,
  ) {
    const alongCoords = axis === "z" ? this.zs : this.xs;
    const minA = alongCoords[0];
    const maxA = alongCoords[alongCoords.length - 1];
    const span = maxA - minA;
    const midA = (minA + maxA) / 2;

    for (const off of [-0.14, 0.14]) {
      const line = new THREE.Mesh(
        new THREE.PlaneGeometry(axis === "z" ? 0.16 : span, axis === "z" ? span : 0.16),
        yellowMat,
      );
      line.rotation.x = -Math.PI / 2;
      if (axis === "z") line.position.set(pos + off, 0.04, midA);
      else line.position.set(midA, 0.04, pos + off);
      this.group.add(line);
    }

    const dashLen = 3.5;
    const gap = 4.0;
    const clear = ROAD_WIDTH / 2 + 4;
    for (const laneSide of [-1, 1]) {
      const laneX = pos + laneSide * LANE_WIDTH;
      let d = minA;
      while (d < maxA) {
        const mid = d + dashLen / 2;
        let inJunction = false;
        for (const jz of alongCoords) {
          if (Math.abs(mid - jz) < clear) {
            inJunction = true;
            break;
          }
        }
        if (!inJunction) {
          const dash = new THREE.Mesh(
            new THREE.PlaneGeometry(axis === "z" ? 0.12 : dashLen, axis === "z" ? dashLen : 0.12),
            lineMat,
          );
          dash.rotation.x = -Math.PI / 2;
          if (axis === "z") dash.position.set(laneX, 0.045, mid);
          else dash.position.set(mid, 0.045, laneX);
          this.group.add(dash);

          if (Math.floor((mid - minA) / 28) % 2 === 0) {
            const travelDir = (axis === "z"
              ? (laneSide > 0 ? 1 : -1)
              : (laneSide < 0 ? 1 : -1)) as TravelDir;
            this.addKeepLeftArrow(axis, pos, mid, travelDir, lineMat);
          }
        }
        d += dashLen + gap;
      }
    }

    for (const side of [-1, 1]) {
      const edge = new THREE.Mesh(
        new THREE.PlaneGeometry(axis === "z" ? 0.14 : span, axis === "z" ? span : 0.14),
        lineMat,
      );
      edge.rotation.x = -Math.PI / 2;
      const off = side * (ROAD_WIDTH / 2 - 0.25);
      if (axis === "z") edge.position.set(pos + off, 0.043, midA);
      else edge.position.set(midA, 0.043, pos + off);
      this.group.add(edge);
    }
  }

  private addTree(x: number, z: number) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.28, 1.6, 7),
      new THREE.MeshStandardMaterial({ color: 0x5d4037, roughness: 0.9 }),
    );
    trunk.position.set(x, 0.8, z);
    trunk.castShadow = true;
    this.group.add(trunk);
    const leafMat = new THREE.MeshStandardMaterial({
      color: 0x2e7d32,
      roughness: 0.85,
      flatShading: true,
    });
    for (const [oy, s] of [
      [2.1, 1.3],
      [2.7, 1.0],
      [3.2, 0.7],
    ] as const) {
      const leaves = new THREE.Mesh(new THREE.DodecahedronGeometry(s, 0), leafMat);
      leaves.position.set(x, oy, z);
      leaves.castShadow = true;
      this.group.add(leaves);
    }
  }

  /**
   * Mast-arm traffic signals over each approach.
   * Large glowing lamps + point lights so colors are obvious.
   */
  private addTrafficLight(
    x: number,
    z: number,
    phaseOffset = 0,
    arms: JunctionArms = { n: true, s: true, e: true, w: true },
  ) {
    const group = new THREE.Group();
    const poleMat = new THREE.MeshStandardMaterial({
      color: 0x333333,
      metalness: 0.65,
      roughness: 0.35,
    });
    const housingMat = new THREE.MeshStandardMaterial({
      color: 0x111111,
      metalness: 0.4,
      roughness: 0.45,
    });
    const nsLamps: LightLamp[] = [];
    const ewLamps: LightLamp[] = [];
    const armLamps: LightState["armLamps"] = {};
    const timerFaces: LightState["timers"] = [];

    // Poles sit farther from the junction box
    const back = ROAD_WIDTH / 2 + LIGHT_SETBACK;
    const side = ROAD_WIDTH / 2 + 1.4;

    // yaw: PlaneGeometry / lamp +Z faces approaching traffic after rotation.y
    // (local +Z → world (sin(yaw), cos(yaw)))
    const approaches: {
      facing: "ns" | "ew";
      armKey: keyof JunctionArms;
      poleX: number;
      poleZ: number;
      yaw: number;
      armDirX: number;
      armDirZ: number;
    }[] = [
      {
        facing: "ns",
        armKey: "s",
        // South approach: cars from -Z → face -Z
        poleX: side,
        poleZ: -back,
        yaw: Math.PI,
        armDirX: -1,
        armDirZ: 0,
      },
      {
        facing: "ns",
        armKey: "n",
        // North approach: cars from +Z → face +Z
        poleX: -side,
        poleZ: back,
        yaw: 0,
        armDirX: 1,
        armDirZ: 0,
      },
      {
        facing: "ew",
        armKey: "w",
        // West approach: cars from -X → face -X
        poleX: -back,
        poleZ: -side,
        yaw: -Math.PI / 2,
        armDirX: 0,
        armDirZ: 1,
      },
      {
        facing: "ew",
        armKey: "e",
        // East approach: cars from +X → face +X
        poleX: back,
        poleZ: side,
        yaw: Math.PI / 2,
        armDirX: 0,
        armDirZ: -1,
      },
    ];

    for (const a of approaches) {
      if (!arms[a.armKey]) continue;
      const px = x + a.poleX;
      const pz = z + a.poleZ;

      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 5.5, 12), poleMat);
      pole.position.set(px, 2.75, pz);
      pole.castShadow = true;
      group.add(pole);

      const armLen = ROAD_WIDTH * 0.55;
      const arm = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, armLen), poleMat);
      arm.position.set(px + a.armDirX * (armLen / 2), 5.3, pz + a.armDirZ * (armLen / 2));
      if (Math.abs(a.armDirX) > 0.5) arm.rotation.y = Math.PI / 2;
      group.add(arm);

      const hx = px + a.armDirX * (armLen * 0.75);
      const hz = pz + a.armDirZ * (armLen * 0.75);
      const hy = 4.6;

      const board = new THREE.Mesh(new THREE.BoxGeometry(0.7, 1.85, 0.12), housingMat);
      board.position.set(hx, hy, hz);
      board.rotation.y = a.yaw;
      group.add(board);

      const housing = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.65, 0.4), housingMat);
      housing.position.set(hx, hy, hz);
      housing.rotation.y = a.yaw;
      housing.translateZ(0.12);
      group.add(housing);

      const lampTargets = a.facing === "ns" ? nsLamps : ewLamps;
      if (!armLamps[a.armKey]) armLamps[a.armKey] = [];
      const armLampTargets = armLamps[a.armKey]!;
      const colors = [
        { idle: 0x2a0808, on: 0xff1a1a },
        { idle: 0x2a2208, on: 0xffcc00 },
        { idle: 0x082a08, on: 0x00ff55 },
      ];

      for (let i = 0; i < 3; i++) {
        const mat = new THREE.MeshBasicMaterial({ color: colors[i].idle });
        const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.22, 16, 12), mat);
        lamp.position.set(hx, hy + 0.5 - i * 0.52, hz);
        lamp.rotation.y = a.yaw;
        lamp.translateZ(0.32);
        group.add(lamp);

        const halo = new THREE.Mesh(
          new THREE.CircleGeometry(0.32, 16),
          new THREE.MeshBasicMaterial({
            color: colors[i].on,
            transparent: true,
            opacity: 0,
            side: THREE.DoubleSide,
            depthWrite: false,
          }),
        );
        halo.position.copy(lamp.position);
        halo.rotation.y = a.yaw;
        halo.translateZ(0.02);
        group.add(halo);

        const visor = new THREE.Mesh(
          new THREE.CylinderGeometry(0.26, 0.26, 0.14, 12, 1, true, 0, Math.PI),
          housingMat,
        );
        visor.position.copy(lamp.position);
        visor.rotation.y = a.yaw;
        visor.rotation.x = Math.PI / 2;
        visor.translateY(0.1);
        group.add(visor);

        const entry = { mat, mesh: lamp };
        lampTargets.push(entry);
        armLampTargets.push(entry);
        mat.userData = { idle: colors[i].idle, on: colors[i].on, halo };
      }

      // Countdown timer under the signal head
      const canvas = document.createElement("canvas");
      canvas.width = 128;
      canvas.height = 64;
      const ctx = canvas.getContext("2d")!;
      const tex = new THREE.CanvasTexture(canvas);
      const tMat = new THREE.MeshBasicMaterial({
        map: tex,
        transparent: true,
        side: THREE.DoubleSide,
      });
      const tMesh = new THREE.Mesh(new THREE.PlaneGeometry(0.85, 0.42), tMat);
      tMesh.position.set(hx, hy - 1.15, hz);
      tMesh.rotation.y = a.yaw;
      tMesh.translateZ(0.28);
      group.add(tMesh);
      timerFaces.push({ mesh: tMesh, mat: tMat, canvas, ctx, facing: a.facing, arm: a.armKey });
    }

    this.group.add(group);
    const state: LightState = {
      x,
      z,
      phase: phaseOffset === 0 ? 0 : 2,
      timer: LIGHT_GREEN,
      group,
      nsLamps,
      ewLamps,
      armLamps,
      arms,
      exclusiveArm: null,
      timers: timerFaces,
    };
    this.lights.push(state);
    this.applyLightColors(state);
    this.paintLightTimers(state);
  }

  private phaseDuration(phase: number, prefer: "ns" | "ew" | null = null): number {
    // 0 NS G · 1 NS Y · 2 EW G · 3 EW Y
    if (phase === 1 || phase === 3) return LIGHT_YELLOW;
    if (!prefer) return LIGHT_GREEN_NORMAL;
    if (phase === 0) return prefer === "ew" ? LIGHT_GREEN_CROSS : LIGHT_GREEN;
    return prefer === "ns" ? LIGHT_GREEN_CROSS : LIGHT_GREEN;
  }

  updateLights(dt: number, player?: { x: number; z: number; yaw: number }) {
    this.lightTime += dt;
    for (const L of this.lights) {
      const prefer = player ? this.playerPreferAxis(L, player) : null;
      const playerArm = player && prefer ? this.playerApproachArm(L, player) : null;
      if (prefer) this.prioritizePlayerRoute(L, prefer, playerArm);
      else L.exclusiveArm = null;
      L.timer -= dt;
      if (L.timer <= 0) {
        L.phase = (L.phase + 1) % 4;
        L.timer += this.phaseDuration(L.phase, prefer);
        if (L.timer <= 0) L.timer = this.phaseDuration(L.phase, prefer);
        this.assignExclusiveArm(L, prefer, playerArm);
      } else if (prefer) {
        this.assignExclusiveArm(L, prefer, playerArm);
      }
      this.applyLightColors(L);
      this.paintLightTimers(L);
    }
  }

  /** Player's approach arm at this junction (n/s/e/w). */
  private playerApproachArm(
    L: LightState,
    player: { x: number; z: number; yaw: number },
  ): keyof JunctionArms {
    const onNS = Math.abs(player.x - L.x) < ROAD_WIDTH * 0.7;
    if (onNS) return player.z < L.z ? "s" : "n";
    return player.x < L.x ? "w" : "e";
  }

  /**
   * Player junction: only OUR approach is green (every other arm red).
   * All other junctions: no exclusive arm — equal NS/EW control.
   */
  private assignExclusiveArm(
    L: LightState,
    prefer: "ns" | "ew" | null,
    playerArm: keyof JunctionArms | null,
  ) {
    if (!prefer || !playerArm) {
      L.exclusiveArm = null;
      return;
    }
    const isYellow = L.phase === 1 || L.phase === 3;
    const playerPriorityGreen =
      (prefer === "ns" && (L.phase === 0 || L.phase === 1)) ||
      (prefer === "ew" && (L.phase === 2 || L.phase === 3));
    if (playerPriorityGreen) {
      L.exclusiveArm = playerArm;
      return;
    }
    if (isYellow) return;
    // Player is on red: opposing axis runs normally (both directions)
    L.exclusiveArm = null;
  }

  /** Which axis the player is approaching this junction on (or null if far / not approaching). */
  private playerPreferAxis(
    L: LightState,
    player: { x: number; z: number; yaw: number },
  ): "ns" | "ew" | null {
    const dx = player.x - L.x;
    const dz = player.z - L.z;
    const dist = Math.hypot(dx, dz);
    // Long boulevards: start serving our road well before we reach the box
    if (dist > 220) return null;

    const onNS = Math.abs(dx) < ROAD_WIDTH * 0.85;
    const onEW = Math.abs(dz) < ROAD_WIDTH * 0.85;
    if (!onNS && !onEW) return null;

    const fwdX = Math.sin(player.yaw);
    const fwdZ = Math.cos(player.yaw);
    // Light ahead of travel (dot of player→light with forward)
    const toLightDot = -dx * fwdX + -dz * fwdZ;
    const insideBox = dist < ROAD_WIDTH * 0.7;
    if (!insideBox && toLightDot < -0.15) return null;

    if (onNS && !onEW) return "ns";
    if (onEW && !onNS) return "ew";
    return Math.abs(fwdZ) >= Math.abs(fwdX) ? "ns" : "ew";
  }

  /**
   * Player road gets the long green. Red for us is never more than LIGHT_RED (10s):
   * one other approach may move, then yellow, then we go.
   */
  private prioritizePlayerRoute(
    L: LightState,
    prefer: "ns" | "ew",
    playerArm: keyof JunctionArms | null,
  ) {
    const opposingGreen = prefer === "ns" ? 2 : 0;
    const opposingYellow = opposingGreen + 1;
    // Remaining red = leftover opposing green + yellow (or leftover yellow)
    const maxGreenLeft = Math.max(0.5, LIGHT_RED - LIGHT_YELLOW);
    if (L.phase === opposingGreen && L.timer > maxGreenLeft) {
      L.timer = maxGreenLeft;
      if (!L.exclusiveArm) this.assignExclusiveArm(L, prefer, playerArm);
    }
    if ((L.phase === opposingGreen || L.phase === opposingYellow) && !L.exclusiveArm) {
      this.assignExclusiveArm(L, prefer, playerArm);
    }
  }

  /** Colour for a specific approach arm (vehicles must use this, not axis alone). */
  signalForApproach(arm: keyof JunctionArms, light: LightState): "RED" | "YELLOW" | "GREEN" {
    if (light.exclusiveArm) {
      if (arm !== light.exclusiveArm) return "RED";
      if (light.phase === 1 || light.phase === 3) return "YELLOW";
      return "GREEN";
    }
    return this.signalFor(axisOfArm(arm), light);
  }

  /** Seconds left on the CURRENT colour for this approach (one countdown, not stacked phases). */
  signalSeconds(axis: "ns" | "ew", light: LightState): number {
    const color = this.signalFor(axis, light);
    const t = Math.max(0, light.timer);
    if (color === "GREEN" || color === "YELLOW") return t;
    // RED: remaining until our green = rest of cross green + cross yellow
    if (axis === "ns") {
      if (light.phase === 2) return t + LIGHT_YELLOW;
      return t;
    }
    if (light.phase === 0) return t + LIGHT_YELLOW;
    return t;
  }

  /** Per-approach countdown (respects exclusive single-road green). */
  signalSecondsForApproach(arm: keyof JunctionArms, light: LightState): number {
    const color = this.signalForApproach(arm, light);
    const t = Math.max(0, light.timer);
    if (color === "GREEN" || color === "YELLOW") return t;
    // Red while another arm holds the exclusive slot
    if (light.exclusiveArm && light.exclusiveArm !== arm) {
      if (light.phase === 0 || light.phase === 2) return t + LIGHT_YELLOW;
      return t;
    }
    return this.signalSeconds(axisOfArm(arm), light);
  }

  private paintLightTimers(L: LightState) {
    for (const t of L.timers) {
      const sig = this.signalForApproach(t.arm, L);
      const secs = Math.max(0, Math.ceil(this.signalSecondsForApproach(t.arm, L)));
      const color = sig === "GREEN" ? "#00ff55" : sig === "YELLOW" ? "#ffcc00" : "#ff1a1a";
      const ctx = t.ctx;
      ctx.clearRect(0, 0, 128, 64);
      ctx.fillStyle = "rgba(0,0,0,0.75)";
      ctx.fillRect(0, 0, 128, 64);
      ctx.fillStyle = color;
      ctx.font = "bold 36px Orbitron, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(`${secs}`, 64, 32);
      const map = t.mat.map as THREE.CanvasTexture;
      map.needsUpdate = true;
    }
  }

  private applyLightColors(L: LightState) {
    const yellowOn = Math.floor(this.lightTime * 2) % 2 === 0; // 2 Hz blink
    const set = (lamps: LightLamp[], mode: "g" | "y" | "r") => {
      for (let i = 0; i < lamps.length; i++) {
        const slot = i % 3;
        let active =
          (mode === "r" && slot === 0) ||
          (mode === "y" && slot === 1) ||
          (mode === "g" && slot === 2);
        if (mode === "y" && !yellowOn) active = false;
        const lamp = lamps[i];
        const idle = lamp.mat.userData.idle as number;
        const on = lamp.mat.userData.on as number;
        const halo = lamp.mat.userData.halo as THREE.Mesh;
        const haloMat = halo.material as THREE.MeshBasicMaterial;
        if (active) {
          lamp.mat.color.setHex(on);
          lamp.mesh.scale.setScalar(1.15);
          haloMat.opacity = mode === "y" ? 0.7 : 0.55;
        } else {
          lamp.mat.color.setHex(idle);
          lamp.mesh.scale.setScalar(1);
          haloMat.opacity = 0;
        }
      }
    };

    if (L.exclusiveArm) {
      // Only the chosen approach is green/yellow; every other head stays red
      const exMode: "g" | "y" = L.phase === 1 || L.phase === 3 ? "y" : "g";
      for (const arm of ["n", "s", "e", "w"] as const) {
        const lamps = L.armLamps[arm];
        if (!lamps) continue;
        set(lamps, arm === L.exclusiveArm ? exMode : "r");
      }
      return;
    }

    // Full-axis mode (player priority green): classical 4-phase
    if (L.phase === 0) {
      set(L.nsLamps, "g");
      set(L.ewLamps, "r");
    } else if (L.phase === 1) {
      set(L.nsLamps, "y");
      set(L.ewLamps, "r");
    } else if (L.phase === 2) {
      set(L.nsLamps, "r");
      set(L.ewLamps, "g");
    } else {
      set(L.nsLamps, "r");
      set(L.ewLamps, "y");
    }
  }

  /**
   * Seconds of RED remaining for vehicles on `axis` (0 if not red).
   * Pedestrians use this to decide whether they can finish crossing in time.
   */
  redRemaining(axis: "ns" | "ew", light: LightState): number {
    if (this.signalFor(axis, light) !== "RED") return 0;
    return this.signalSeconds(axis, light);
  }

  /** Light at a junction centre, if any */
  lightAt(jx: number, jz: number): LightState | null {
    return this.lights.find((L) => Math.abs(L.x - jx) < 1 && Math.abs(L.z - jz) < 1) ?? null;
  }

  /**
   * Axis-level signal. With exclusiveArm set, the axis that owns that arm is
   * treated as green/yellow (traffic is moving there); the other axis is red.
   * Player HUD should prefer signalForApproach for their own arm.
   */
  signalFor(axis: "ns" | "ew", light: LightState): "RED" | "YELLOW" | "GREEN" {
    if (light.exclusiveArm) {
      const exAxis = axisOfArm(light.exclusiveArm);
      if (axis !== exAxis) return "RED";
      if (light.phase === 1 || light.phase === 3) return "YELLOW";
      return "GREEN";
    }
    if (axis === "ns") {
      if (light.phase === 0) return "GREEN";
      if (light.phase === 1) return "YELLOW";
      return "RED";
    }
    if (light.phase === 2) return "GREEN";
    if (light.phase === 3) return "YELLOW";
    return "RED";
  }

  /**
   * Nearest signal on the player's corridor.
   * If yaw is provided, prefer lights AHEAD (not behind) so we plan the next turn to P.
   */
  nearestLight(
    x: number,
    z: number,
    yaw?: number,
  ): { light: LightState; dist: number; axis: "ns" | "ew" } | null {
    let best: { light: LightState; dist: number; axis: "ns" | "ew" } | null = null;
    const alongMax = 75;
    const fwdX = yaw !== undefined ? Math.sin(yaw) : 0;
    const fwdZ = yaw !== undefined ? Math.cos(yaw) : 0;
    const useFwd = yaw !== undefined;

    for (const L of this.lights) {
      const dx = L.x - x;
      const dz = L.z - z;
      const adx = Math.abs(dx);
      const adz = Math.abs(dz);

      // NS corridor (vertical road)
      if (adx < ROAD_WIDTH * 0.65 && adz < alongMax && adz > 1) {
        const ahead = !useFwd || dz * fwdZ + dx * fwdX > -2;
        if (ahead && (!best || adz < best.dist)) {
          best = { light: L, dist: adz, axis: "ns" };
        }
      }
      // EW corridor (horizontal road)
      if (adz < ROAD_WIDTH * 0.65 && adx < alongMax && adx > 1) {
        const ahead = !useFwd || dz * fwdZ + dx * fwdX > -2;
        if (ahead && (!best || adx < best.dist)) {
          best = { light: L, dist: adx, axis: "ew" };
        }
      }
    }
    return best;
  }

  isRedFor(axis: "ns" | "ew", light: LightState): boolean {
    return this.signalFor(axis, light) === "RED";
  }

  hitBuilding(box: { minX: number; maxX: number; minZ: number; maxZ: number }): boolean {
    for (const b of this.buildingBoxes) {
      if (box.minX < b.maxX && box.maxX > b.minX && box.minZ < b.maxZ && box.maxZ > b.minZ) {
        return true;
      }
    }
    return false;
  }

  laneCenterOnVerticalRoad(roadX: number, lane: number): number {
    return laneCenter("z", roadX, lane);
  }
}
