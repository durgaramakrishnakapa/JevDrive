import * as THREE from "three";
import { ROAD_WIDTH } from "./constants";
import type { CityPlace } from "./places";

export type Collider = { minX: number; maxX: number; minZ: number; maxZ: number };

function hexCss(n: number): string {
  return `#${n.toString(16).padStart(6, "0")}`;
}

function mat(color: number, extra: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.72, metalness: 0.08, ...extra });
}

function addBox(
  g: THREE.Group,
  boxes: Collider[],
  w: number,
  h: number,
  d: number,
  x: number,
  z: number,
  color: number,
  extra: ConstructorParameters<typeof THREE.MeshStandardMaterial>[0] = {},
): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, extra));
  m.position.set(x, h / 2, z);
  m.castShadow = true;
  m.receiveShadow = true;
  g.add(m);
  boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
  return m;
}

function signTexture(title: string, sub: string, fill: string, accent: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = 512;
  c.height = 256;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = fill;
  ctx.fillRect(0, 0, 512, 256);
  ctx.strokeStyle = accent;
  ctx.lineWidth = 14;
  ctx.strokeRect(10, 10, 492, 236);
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 54px Rajdhani, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(title, 256, 100);
  ctx.font = "600 32px Rajdhani, sans-serif";
  ctx.fillStyle = accent;
  ctx.fillText(sub, 256, 168);
  const tex = new THREE.CanvasTexture(c);
  tex.anisotropy = 4;
  return tex;
}

function addRoadSign(g: THREE.Group, place: CityPlace, x: number, z: number, yaw: number) {
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.08, 0.1, 5.2, 8),
    new THREE.MeshStandardMaterial({ color: 0x5a616c, metalness: 0.5, roughness: 0.4 }),
  );
  post.position.set(x, 2.6, z);
  post.castShadow = true;
  g.add(post);

  const tex = signTexture(place.short, place.name, hexCss(place.color), hexCss(place.accent));
  const board = new THREE.Mesh(
    new THREE.BoxGeometry(4.4, 2.05, 0.08),
    new THREE.MeshStandardMaterial({
      map: tex,
      emissive: place.accent,
      emissiveMap: tex,
      emissiveIntensity: 0.22,
      roughness: 0.45,
    }),
  );
  board.position.set(x, 4.55, z);
  board.rotation.y = yaw;
  board.castShadow = true;
  g.add(board);
}

function padSize(place: CityPlace): { w: number; d: number } {
  const half = ROAD_WIDTH / 2 + 5.5;
  return {
    w: Math.max(16, place.x1 - place.x0 - half * 2),
    d: Math.max(16, place.z1 - place.z0 - half * 2),
  };
}

function buildStadium(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const fw = Math.min(w * 0.62, 48);
  const fd = Math.min(d * 0.55, 36);
  const track = new THREE.Mesh(
    new THREE.PlaneGeometry(fw + 8, fd + 8),
    new THREE.MeshStandardMaterial({ color: 0xb85a3a, roughness: 0.9 }),
  );
  track.rotation.x = -Math.PI / 2;
  track.position.set(cx, 0.06, cz);
  g.add(track);
  const field = new THREE.Mesh(
    new THREE.PlaneGeometry(fw, fd),
    new THREE.MeshStandardMaterial({ color: 0x3d9a46, roughness: 0.95 }),
  );
  field.rotation.x = -Math.PI / 2;
  field.position.set(cx, 0.07, cz);
  g.add(field);
  const stripe = new THREE.Mesh(
    new THREE.PlaneGeometry(fw * 0.04, fd * 0.92),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
  );
  stripe.rotation.x = -Math.PI / 2;
  stripe.position.set(cx, 0.08, cz);
  g.add(stripe);

  const standH = 9;
  const thick = Math.min(6.5, w * 0.12);
  addBox(g, boxes, fw + thick * 2, standH, thick, cx, cz - fd / 2 - thick / 2, 0xcfd6dc);
  addBox(g, boxes, fw + thick * 2, standH, thick, cx, cz + fd / 2 + thick / 2, 0xcfd6dc);
  addBox(g, boxes, thick, standH, fd, cx - fw / 2 - thick / 2, cz, 0xb8c2cc);
  addBox(g, boxes, thick, standH, fd, cx + fw / 2 + thick / 2, cz, 0xb8c2cc);

  for (const [lx, lz] of [
    [cx - fw / 2, cz - fd / 2],
    [cx + fw / 2, cz - fd / 2],
    [cx - fw / 2, cz + fd / 2],
    [cx + fw / 2, cz + fd / 2],
  ] as [number, number][]) {
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.22, 18, 8),
      mat(0x9aa3ad, { metalness: 0.6 }),
    );
    pole.position.set(lx, 9, lz);
    pole.castShadow = true;
    g.add(pole);
    const lamp = new THREE.Mesh(
      new THREE.BoxGeometry(2.2, 0.5, 1.1),
      mat(0xfff8e1, { emissive: 0xffe082, emissiveIntensity: 0.7 }),
    );
    lamp.position.set(lx, 18.2, lz);
    g.add(lamp);
  }
}

function buildMarket(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const colors = [0xe53935, 0xfb8c00, 0xffc107, 0x43a047, 0x1e88e5, 0x8e24aa];
  const cols = 4;
  const rows = 3;
  const gapX = Math.min(w * 0.22, 8);
  const gapZ = Math.min(d * 0.24, 7);
  const ox0 = cx - ((cols - 1) * gapX) / 2;
  const oz0 = cz - ((rows - 1) * gapZ) / 2;
  for (let i = 0; i < cols; i++) {
    for (let j = 0; j < rows; j++) {
      const x = ox0 + i * gapX;
      const z = oz0 + j * gapZ;
      const c = colors[(i + j) % colors.length];
      addBox(g, boxes, 4.2, 2.4, 3.4, x, z, 0xefebe9);
      const roof = new THREE.Mesh(
        new THREE.BoxGeometry(4.8, 0.22, 3.8),
        mat(c, { emissive: c, emissiveIntensity: 0.12 }),
      );
      roof.position.set(x, 2.65, z);
      roof.rotation.z = 0.08;
      g.add(roof);
    }
  }
}

function buildShopping(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const bw = Math.min(w * 0.78, 42);
  const bd = Math.min(d * 0.55, 22);
  addBox(g, boxes, bw, 16, bd, cx, cz, 0x5b7cbf, { metalness: 0.35, roughness: 0.28 });
  addBox(g, boxes, bw * 0.92, 4.2, bd * 0.35, cx, cz + bd * 0.42, 0x90caf9, { metalness: 0.45 });
  const canopy = new THREE.Mesh(new THREE.BoxGeometry(bw * 0.5, 0.35, 6), mat(0x1565c0));
  canopy.position.set(cx, 5.2, cz + bd / 2 + 2);
  g.add(canopy);
}

function buildHospital(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const bw = Math.min(w * 0.7, 36);
  const bd = Math.min(d * 0.4, 16);
  addBox(g, boxes, bw, 14, bd, cx, cz, 0xf4f7fa);
  addBox(g, boxes, bd * 0.7, 14, Math.min(d * 0.7, 28), cx, cz, 0xeef2f6);
  const bar = mat(0xe53935, { emissive: 0xe53935, emissiveIntensity: 0.35 });
  const hBar = new THREE.Mesh(new THREE.BoxGeometry(7, 1.4, 0.4), bar);
  hBar.position.set(cx, 16.2, cz);
  g.add(hBar);
  const vBar = new THREE.Mesh(new THREE.BoxGeometry(1.4, 7, 0.4), bar);
  vBar.position.set(cx, 16.2, cz);
  g.add(vBar);
}

function buildStation(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, _d: number) {
  const len = Math.min(w * 0.85, 48);
  addBox(g, boxes, len, 5.5, 8, cx, cz - 3, 0x8d6e63);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(len + 2, 0.4, 12), mat(0xffb300));
  roof.position.set(cx, 7.2, cz);
  g.add(roof);
  for (const s of [-1, 1]) {
    const col = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.32, 7, 8), mat(0x5d4037));
    col.position.set(cx + s * len * 0.35, 3.5, cz + 3);
    col.castShadow = true;
    g.add(col);
  }
  addBox(g, boxes, 5, 16, 5, cx + len * 0.38, cz + 6, 0x6d4c41);
}

function buildTemple(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const base = Math.min(w, d) * 0.42;
  addBox(g, boxes, base, 3.2, base, cx, cz, 0xd4a017);
  addBox(g, boxes, base * 0.72, 4.5, base * 0.72, cx, cz, 0xe0b422);
  addBox(g, boxes, base * 0.48, 5.5, base * 0.48, cx, cz, 0xc99212);
  const spire = new THREE.Mesh(new THREE.ConeGeometry(base * 0.16, 7, 8), mat(0xfff3c4, { emissive: 0xffc107, emissiveIntensity: 0.2 }));
  spire.position.set(cx, 16.2, cz);
  spire.castShadow = true;
  g.add(spire);
}

function buildCollege(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const bw = Math.min(w * 0.32, 16);
  const bd = Math.min(d * 0.28, 12);
  addBox(g, boxes, bw, 11, bd, cx - w * 0.22, cz, 0x4e7d5b);
  addBox(g, boxes, bw, 9, bd, cx + w * 0.22, cz, 0x3d6b4f);
  addBox(g, boxes, 6, 18, 6, cx, cz - d * 0.12, 0x2f6a48);
  const lawn = new THREE.Mesh(
    new THREE.PlaneGeometry(Math.min(w * 0.35, 18), Math.min(d * 0.28, 12)),
    new THREE.MeshStandardMaterial({ color: 0x66bb6a, roughness: 1 }),
  );
  lawn.rotation.x = -Math.PI / 2;
  lawn.position.set(cx, 0.06, cz + d * 0.12);
  g.add(lawn);
}

function buildItPark(g: THREE.Group, boxes: Collider[], cx: number, cz: number, w: number, d: number) {
  const glass = { metalness: 0.55, roughness: 0.18, emissive: 0x1a237e, emissiveIntensity: 0.08 };
  addBox(g, boxes, 9, 28, 9, cx - w * 0.18, cz, 0x455a78, glass);
  addBox(g, boxes, 8, 22, 8, cx + w * 0.16, cz - d * 0.1, 0x31415f, glass);
  addBox(g, boxes, 7, 18, 7, cx + w * 0.08, cz + d * 0.16, 0x3a4a6b, glass);
}

function buildLandmark(place: CityPlace): { group: THREE.Group; boxes: Collider[] } {
  const g = new THREE.Group();
  const boxes: Collider[] = [];
  const { w, d } = padSize(place);
  const { cx, cz } = place;
  switch (place.kind) {
    case "stadium":
      buildStadium(g, boxes, cx, cz, w, d);
      break;
    case "market":
      buildMarket(g, boxes, cx, cz, w, d);
      break;
    case "shopping":
      buildShopping(g, boxes, cx, cz, w, d);
      break;
    case "hospital":
      buildHospital(g, boxes, cx, cz, w, d);
      break;
    case "station":
      buildStation(g, boxes, cx, cz, w, d);
      break;
    case "temple":
      buildTemple(g, boxes, cx, cz, w, d);
      break;
    case "college":
      buildCollege(g, boxes, cx, cz, w, d);
      break;
    case "itpark":
      buildItPark(g, boxes, cx, cz, w, d);
      break;
  }
  return { group: g, boxes };
}

/**
 * Whole-block destination: coloured ground, roadside name signs, centre beacon,
 * and a landmark that matches the place (stadium, hospital, …).
 */
export function createPlaceAreaMesh(place: CityPlace, mission = false): THREE.Group {
  const g = new THREE.Group();
  const { w, d } = padSize(place);

  const wash = new THREE.Mesh(
    new THREE.PlaneGeometry(w, d),
    new THREE.MeshStandardMaterial({
      color: place.color,
      emissive: place.accent,
      emissiveIntensity: 0.12,
      transparent: true,
      opacity: mission ? 0.22 : 0.1,
      roughness: 0.95,
    }),
  );
  wash.rotation.x = -Math.PI / 2;
  wash.position.set(place.cx, 0.04, place.cz);
  wash.receiveShadow = true;
  g.add(wash);

  const sidewalk = ROAD_WIDTH / 2 + 1.6;
  addRoadSign(g, place, place.cx, place.z0 + sidewalk, 0);
  addRoadSign(g, place, place.cx, place.z1 - sidewalk, Math.PI);
  addRoadSign(g, place, place.x0 + sidewalk, place.cz, Math.PI / 2);
  addRoadSign(g, place, place.x1 - sidewalk, place.cz, -Math.PI / 2);

  if (mission) {
    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.38, 12, 10),
      new THREE.MeshStandardMaterial({
        color: place.accent,
        emissive: place.accent,
        emissiveIntensity: 1.1,
      }),
    );
    beacon.position.set(place.cx, 22, place.cz);
    g.add(beacon);
    g.userData.beacon = beacon;
  }

  return g;
}

export function createPlaceLandmark(place: CityPlace): { group: THREE.Group; boxes: Collider[] } {
  return buildLandmark(place);
}
