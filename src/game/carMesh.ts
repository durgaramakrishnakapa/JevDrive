import * as THREE from "three";

export type VehicleKind = "sedan" | "hatch" | "suv" | "truck" | "lorry" | "bus" | "schoolBus" | "bike" | "auto";

export const LORRY_COLORS = [0xd84315, 0x1565c0, 0x2e7d32, 0xf9a825, 0x6a1b9a, 0x00838f];
/** Indian auto-rickshaw liveries: yellow/black, green/yellow (CNG), black/yellow */
export const AUTO_COLORS = [0xf9c500, 0xf9c500, 0x2e7d32, 0x1b5e20, 0xffd54f];

export function isHeavyVehicle(kind: VehicleKind): boolean {
  return kind === "bus" || kind === "schoolBus" || kind === "truck" || kind === "lorry";
}

const SKIN_TONES = [0xe8b898, 0xd4a574, 0xc68642, 0x8d5524, 0xf1c27d, 0xffdbac];
const SHIRT_COLORS = [0x1565c0, 0xc62828, 0x37474f, 0x2e7d32, 0x6a1b9a, 0xf9a825, 0xffffff, 0x00838f];
const HAIR_COLORS = [0x1a1a1a, 0x3e2723, 0x5d4037, 0x4e342e, 0x212121, 0x6d4c41];

/** School bus yellow */
export const SCHOOL_BUS_YELLOW = 0xffc107;

export function randomTrafficKind(): VehicleKind {
  const r = Math.random();
  if (r < 0.10) return "bike";
  if (r < 0.32) return "auto";
  if (r < 0.32) return "bus";
  if (r < 0.38) return "truck";
  if (r < 0.46) return "lorry";
  if (r < 0.58) return "suv";
  if (r < 0.76) return "hatch";
  return "sedan";
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Classic Dr. Driving–style cars with real windows + visible drivers */
export function createCarMesh(color: number, kind: VehicleKind = "sedan"): THREE.Group {
  const g = new THREE.Group();
  const wheels: THREE.Object3D[] = [];

  const paint = new THREE.MeshStandardMaterial({ color, roughness: 0.38, metalness: 0.35 });
  const dark = new THREE.MeshStandardMaterial({
    color: new THREE.Color(color).multiplyScalar(0.62),
    roughness: 0.42,
    metalness: 0.28,
  });
  const black = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.8 });
  const pillar = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.55, metalness: 0.2 });
  const rubber = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.95 });
  const rim = new THREE.MeshStandardMaterial({ color: 0xbbbbbb, metalness: 0.7, roughness: 0.35 });
  const chrome = new THREE.MeshStandardMaterial({ color: 0xdddddd, metalness: 0.85, roughness: 0.25 });
  const head = new THREE.MeshStandardMaterial({
    color: 0xfff8e1,
    emissive: 0xffe082,
    emissiveIntensity: 0.7,
  });
  const tail = new THREE.MeshStandardMaterial({
    color: 0xff1744,
    emissive: 0xb71c1c,
    emissiveIntensity: 0.55,
  });
  // Realistic tinted glass — see drivers through it
  const glass = new THREE.MeshStandardMaterial({
    color: 0x6ec6ff,
    transparent: true,
    opacity: 0.42,
    roughness: 0.08,
    metalness: 0.55,
    envMapIntensity: 1.2,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  const glassDark = new THREE.MeshStandardMaterial({
    color: 0x4a90a4,
    transparent: true,
    opacity: 0.5,
    roughness: 0.12,
    metalness: 0.45,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  let L = 4.2;
  let W = 1.85;
  let H = 1.4;
  if (kind === "hatch") {
    L = 3.9;
    W = 1.8;
    H = 1.45;
  } else if (kind === "suv") {
    L = 4.5;
    W = 1.95;
    H = 1.75;
  } else if (kind === "truck") {
    L = 6.2;
    W = 2.2;
    H = 2.2;
  } else if (kind === "lorry") {
    L = 9.2;
    W = 2.45;
    H = 3.2;
  } else if (kind === "bus" || kind === "schoolBus") {
    L = 8.5;
    W = 2.4;
    H = 2.8;
  } else if (kind === "bike") {
    L = 2.1;
    W = 0.55;
    H = 1.35;
  } else if (kind === "auto") {
    L = 2.7;
    W = 1.35;
    H = 1.75;
  }

  const box = (w: number, h: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  if (kind === "bike") {
    buildBike(g, box, paint, dark, black, chrome, rubber, rim, head, tail, L, W, H, wheels);
  } else if (kind === "auto") {
    buildAuto(g, box, paint, black, chrome, rubber, rim, glass, head, tail, L, W, H, wheels);
  } else if (kind === "bus" || kind === "schoolBus") {
    buildBus(g, box, paint, dark, black, pillar, chrome, glass, glassDark, head, tail, L, W, H);
    if (kind === "schoolBus") decorateSchoolBus(g, L, W, H);
  } else if (kind === "truck") {
    buildTruck(g, box, paint, dark, black, pillar, chrome, glass, glassDark, head, tail, L, W, H);
  } else if (kind === "lorry") {
    buildLorry(g, box, paint, dark, black, pillar, chrome, glass, glassDark, head, tail, L, W, H);
  } else {
    buildCar(g, box, paint, dark, black, pillar, chrome, glass, glassDark, head, tail, kind, L, W, H);
  }

  // Wheels (bike and auto build their own)
  if (kind !== "bike" && kind !== "auto") {
    const wr = kind === "lorry" ? 0.52 : isHeavyVehicle(kind) ? 0.45 : 0.36;
    const positions: [number, number][] = [
      [W / 2 + 0.02, L * 0.32],
      [-W / 2 - 0.02, L * 0.32],
      [W / 2 + 0.02, -L * 0.3],
      [-W / 2 - 0.02, -L * 0.3],
    ];
    if (kind === "lorry") {
      // tandem rear axles + steer axle further forward
      positions.length = 0;
      positions.push(
        [W / 2 + 0.02, L * 0.36],
        [-W / 2 - 0.02, L * 0.36],
        [W / 2 + 0.02, -L * 0.22],
        [-W / 2 - 0.02, -L * 0.22],
        [W / 2 + 0.02, -L * 0.36],
        [-W / 2 - 0.02, -L * 0.36],
      );
    } else if (isHeavyVehicle(kind)) {
      positions.push([W / 2 + 0.02, -L * 0.08], [-W / 2 - 0.02, -L * 0.08]);
    }

    for (const [x, z] of positions) {
      const wheel = new THREE.Group();
      const tire = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, 0.28, 14), rubber);
      tire.rotation.z = Math.PI / 2;
      tire.castShadow = true;
      wheel.add(tire);
      const hub = new THREE.Mesh(new THREE.CylinderGeometry(wr * 0.55, wr * 0.55, 0.3, 10), rim);
      hub.rotation.z = Math.PI / 2;
      wheel.add(hub);
      wheel.position.set(x, wr, z);
      g.add(wheel);
      wheels.push(wheel);
    }
  }

  g.userData.dims = { length: L, width: W, height: H };
  g.userData.wheels = wheels;
  g.userData.kind = kind;
  attachVehicleLights(g, L, W, kind);
  return g;
}

type BoxFn = (
  w: number,
  h: number,
  d: number,
  mat: THREE.Material,
  x: number,
  y: number,
  z: number,
) => THREE.Mesh;

/** Working headlights, taillights, and turn indicators on every vehicle */
function attachVehicleLights(g: THREE.Group, L: number, W: number, kind: VehicleKind) {
  const isBike = kind === "bike";
  const isAuto = kind === "auto";
  const ly =
    kind === "bus" || kind === "schoolBus"
      ? 0.55
      : kind === "lorry"
        ? 0.72
        : kind === "truck"
          ? 0.5
          : kind === "suv"
            ? 0.5
            : 0.42;
  const headY = isBike ? 0.85 : ly;
  const tailY = isBike ? 0.7 : ly - 0.02;
  const headZ = isBike ? L * 0.35 : L / 2 + 0.04;
  const tailZ = isBike ? -L * 0.4 : -L / 2 - 0.04;
  const hx = isBike ? 0 : W * 0.32;
  const tx = isBike ? 0 : W * 0.3;

  const mkHead = () =>
    new THREE.MeshStandardMaterial({
      color: 0xfff8e1,
      emissive: 0xffe082,
      emissiveIntensity: 0.85,
      roughness: 0.35,
    });
  const mkTail = () =>
    new THREE.MeshStandardMaterial({
      color: 0xff1744,
      emissive: 0xb71c1c,
      emissiveIntensity: 0.45,
      roughness: 0.4,
    });
  const mkBlink = () =>
    new THREE.MeshStandardMaterial({
      color: 0xff9800,
      emissive: 0xff6d00,
      emissiveIntensity: 0.05,
      roughness: 0.4,
    });

  const headMats: THREE.MeshStandardMaterial[] = [];
  const tailMats: THREE.MeshStandardMaterial[] = [];
  const blinkL: THREE.MeshStandardMaterial[] = [];
  const blinkR: THREE.MeshStandardMaterial[] = [];

  const add = (
    w: number,
    h: number,
    d: number,
    mat: THREE.MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
  ) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    g.add(m);
    return m;
  };

  if (isBike) {
    const hm = mkHead();
    headMats.push(hm);
    add(0.14, 0.12, 0.08, hm, 0, headY, headZ);
    const tm = mkTail();
    tailMats.push(tm);
    add(0.1, 0.08, 0.06, tm, 0, tailY, tailZ);
    const bl = mkBlink();
    const br = mkBlink();
    blinkL.push(bl);
    blinkR.push(br);
    // NOTE: with the chase camera, screen-left is the mesh's local +X side
    add(0.08, 0.06, 0.05, bl, 0.22, 1.0, L * 0.25);
    add(0.08, 0.06, 0.05, br, -0.22, 1.0, L * 0.25);
  } else if (isAuto) {
    const bl = mkBlink();
    const br = mkBlink();
    blinkL.push(bl);
    blinkR.push(br);
    add(0.1, 0.08, 0.05, bl, W * 0.42, 1.15, L * 0.22);
    add(0.1, 0.08, 0.05, br, -W * 0.42, 1.15, L * 0.22);
    add(0.1, 0.08, 0.05, bl, W * 0.42, 0.7, -L * 0.46);
    add(0.1, 0.08, 0.05, br, -W * 0.42, 0.7, -L * 0.46);
  } else {
    for (const side of [-1, 1]) {
      const hm = mkHead();
      headMats.push(hm);
      add(0.26, 0.13, 0.08, hm, side * hx, headY, headZ);
      const tm = mkTail();
      tailMats.push(tm);
      add(0.24, 0.11, 0.07, tm, side * tx, tailY, tailZ);
    }
    const blF = mkBlink();
    const blR = mkBlink();
    const brF = mkBlink();
    const brR = mkBlink();
    blinkL.push(blF, blR);
    blinkR.push(brF, brR);
    // Screen-left (travelLeft) is local +X: left indicators live on +X, right on -X
    add(0.12, 0.08, 0.06, blF, W * 0.48, headY, headZ - 0.02);
    add(0.12, 0.08, 0.06, blR, W * 0.48, tailY, tailZ + 0.02);
    add(0.12, 0.08, 0.06, brF, -W * 0.48, headY, headZ - 0.02);
    add(0.12, 0.08, 0.06, brR, -W * 0.48, tailY, tailZ + 0.02);
  }

  g.userData.lights = { headMats, tailMats, blinkL, blinkR };
}

export type SignalState = {
  headlights?: boolean;
  brake?: boolean;
  blinkLeft?: boolean;
  blinkRight?: boolean;
  time?: number;
};

/** Update emissive headlights / tails / turn signals */
export function setVehicleSignals(mesh: THREE.Group, state: SignalState) {
  const lights = mesh.userData.lights as
    | {
        headMats: THREE.MeshStandardMaterial[];
        tailMats: THREE.MeshStandardMaterial[];
        blinkL: THREE.MeshStandardMaterial[];
        blinkR: THREE.MeshStandardMaterial[];
      }
    | undefined;
  if (!lights) return;

  const headOn = state.headlights !== false;
  for (const m of lights.headMats) {
    m.emissiveIntensity = headOn ? 0.95 : 0.15;
    m.color.setHex(headOn ? 0xfffde7 : 0x888888);
  }

  const brake = !!state.brake;
  for (const m of lights.tailMats) {
    m.emissiveIntensity = brake ? 1.35 : 0.55;
    m.emissive.setHex(brake ? 0xff1744 : 0xb71c1c);
  }

  const t = state.time ?? 0;
  const flash = Math.sin(t * Math.PI * 4) > 0; // ~2 Hz
  const leftOn = !!state.blinkLeft && flash;
  const rightOn = !!state.blinkRight && flash;
  for (const m of lights.blinkL) {
    m.emissiveIntensity = leftOn ? 1.6 : 0.05;
    m.color.setHex(leftOn ? 0xffb300 : 0x5a3a00);
  }
  for (const m of lights.blinkR) {
    m.emissiveIntensity = rightOn ? 1.6 : 0.05;
    m.color.setHex(rightOn ? 0xffb300 : 0x5a3a00);
  }
}

function buildCar(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  dark: THREE.Material,
  black: THREE.Material,
  pillar: THREE.Material,
  chrome: THREE.Material,
  glass: THREE.Material,
  glassDark: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  kind: "sedan" | "hatch" | "suv",
  L: number,
  W: number,
  H: number,
) {
  const cabinZ = kind === "hatch" ? -0.08 : kind === "suv" ? -0.02 : -0.05;
  const cabinLen = kind === "suv" ? L * 0.48 : kind === "hatch" ? L * 0.46 : L * 0.38;
  const cabinH = kind === "suv" ? H * 0.42 : H * 0.36;
  const cabinY = H * 0.52;
  const roofY = cabinY + cabinH * 0.42;

  // Lower body
  box(W, H * 0.32, L * 0.95, paint, 0, H * 0.28, 0);
  // Hood
  const hoodLen = kind === "hatch" ? L * 0.28 : L * 0.32;
  box(W * 0.92, H * 0.1, hoodLen, dark, 0, H * 0.4, L * 0.28);
  // Cabin shell (sides / roof frame — open for windows)
  box(W * 0.88, cabinH * 0.22, cabinLen, paint, 0, roofY, cabinZ); // roof
  // Floor / belt line under windows
  box(W * 0.88, 0.08, cabinLen, paint, 0, cabinY - cabinH * 0.35, cabinZ);

  // A / B / C pillars (black frames like real cars)
  const pillarH = cabinH * 0.85;
  const pillarY = cabinY;
  const frontZ = cabinZ + cabinLen * 0.42;
  const midZ = cabinZ;
  const rearZ = cabinZ - cabinLen * 0.42;
  for (const x of [-W * 0.42, W * 0.42]) {
    box(0.07, pillarH, 0.1, pillar, x, pillarY, frontZ); // A
    box(0.06, pillarH, 0.08, pillar, x, pillarY, midZ); // B
    box(0.07, pillarH, 0.1, pillar, x, pillarY, rearZ); // C
  }

  // Windshield (front)
  const ws = box(W * 0.78, cabinH * 0.72, 0.06, glass, 0, cabinY + 0.02, cabinZ + cabinLen * 0.48);
  ws.rotation.x = -0.28;
  // Rear window
  const rw = box(W * 0.74, cabinH * 0.65, 0.06, glassDark, 0, cabinY + 0.02, cabinZ - cabinLen * 0.48);
  rw.rotation.x = 0.22;
  // Side windows (left / right) — front + rear panes
  const sideH = cabinH * 0.62;
  const sideY = cabinY + 0.02;
  const sideX = W * 0.44;
  box(0.05, sideH, cabinLen * 0.32, glass, sideX, sideY, cabinZ + cabinLen * 0.18);
  box(0.05, sideH, cabinLen * 0.28, glassDark, sideX, sideY, cabinZ - cabinLen * 0.16);
  box(0.05, sideH, cabinLen * 0.32, glass, -sideX, sideY, cabinZ + cabinLen * 0.18);
  box(0.05, sideH, cabinLen * 0.28, glassDark, -sideX, sideY, cabinZ - cabinLen * 0.16);

  // Interior (so cabin isn't empty behind glass)
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.9 });
  // Seats lower in cabin so driver fits under the roof
  box(W * 0.7, 0.08, cabinLen * 0.7, seatMat, 0, cabinY - cabinH * 0.32, cabinZ);
  box(0.34, 0.32, 0.1, seatMat, -W * 0.22, cabinY - cabinH * 0.12, cabinZ - cabinLen * 0.08);
  box(0.34, 0.32, 0.1, seatMat, W * 0.22, cabinY - cabinH * 0.12, cabinZ - cabinLen * 0.08);

  // Driver stays under roof (roofY clears head)
  addDriver(g, -W * 0.2, cabinY - cabinH * 0.28, cabinZ + cabinLen * 0.04, roofY - 0.06, true);

  // Trunk
  if (kind === "sedan") {
    box(W * 0.9, H * 0.14, L * 0.2, dark, 0, H * 0.38, -L * 0.34);
  }
  // Bumpers / grill / lights / mirrors
  box(W * 1.02, 0.18, 0.2, chrome, 0, 0.28, L / 2 - 0.05);
  box(W * 1.02, 0.16, 0.18, chrome, 0, 0.26, -L / 2 + 0.05);
  box(W * 0.45, 0.14, 0.06, black, 0, 0.4, L / 2 + 0.02);
  const ly = kind === "suv" ? 0.5 : 0.42;
  for (const x of [-W * 0.32, W * 0.32]) {
    box(0.28, 0.14, 0.08, head, x, ly, L / 2 + 0.02);
    box(0.26, 0.12, 0.08, tail, x, ly - 0.02, -L / 2 - 0.02);
  }
  box(0.1, 0.08, 0.18, black, W / 2 + 0.08, H * 0.5, L * 0.08);
  box(0.1, 0.08, 0.18, black, -W / 2 - 0.08, H * 0.5, L * 0.08);
  box(0.45, 0.12, 0.03, chrome, 0, 0.3, L / 2 + 0.1);
  box(0.45, 0.12, 0.03, chrome, 0, 0.3, -L / 2 - 0.08);
}

function buildTruck(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  dark: THREE.Material,
  black: THREE.Material,
  pillar: THREE.Material,
  chrome: THREE.Material,
  glass: THREE.Material,
  glassDark: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  L: number,
  W: number,
  H: number,
) {
  const cabZ = L * 0.28;
  // Cab body
  box(W * 0.95, H * 0.35, 2.0, paint, 0, H * 0.32, cabZ);
  box(W * 0.88, H * 0.12, 1.5, paint, 0, H * 0.78, cabZ); // roof
  box(W * 0.88, 0.1, 1.5, paint, 0, H * 0.48, cabZ); // belt
  // Pillars
  for (const x of [-W * 0.4, W * 0.4]) {
    box(0.08, H * 0.32, 0.1, pillar, x, H * 0.62, cabZ + 0.55);
    box(0.08, H * 0.32, 0.1, pillar, x, H * 0.62, cabZ - 0.55);
  }
  // Windshield + rear cab glass + sides
  const ws = box(W * 0.78, H * 0.28, 0.06, glass, 0, H * 0.62, cabZ + 0.72);
  ws.rotation.x = -0.2;
  box(W * 0.75, H * 0.26, 0.05, glassDark, 0, H * 0.62, cabZ - 0.72);
  box(0.05, H * 0.26, 1.1, glass, W * 0.44, H * 0.62, cabZ);
  box(0.05, H * 0.26, 1.1, glass, -W * 0.44, H * 0.62, cabZ);
  // Seats + driver
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x333333, roughness: 0.9 });
  box(0.36, 0.32, 0.1, seatMat, -W * 0.2, H * 0.5, cabZ - 0.15);
  const cabRoof = H * 0.78;
  addDriver(g, -W * 0.2, H * 0.42, cabZ + 0.05, cabRoof - 0.08, true);
  // Bed
  box(W, H * 0.25, L * 0.48, dark, 0, H * 0.3, -L * 0.12);
  box(W * 0.08, H * 0.45, L * 0.45, black, W * 0.46, H * 0.45, -L * 0.12);
  box(W * 0.08, H * 0.45, L * 0.45, black, -W * 0.46, H * 0.45, -L * 0.12);
  box(W * 1.02, 0.2, 0.2, chrome, 0, 0.3, L / 2 - 0.05);
  for (const x of [-W * 0.32, W * 0.32]) {
    box(0.28, 0.16, 0.08, head, x, 0.5, L / 2 + 0.02);
    box(0.22, 0.14, 0.08, tail, x, 0.45, -L / 2 - 0.02);
  }
}

/** Indian goods lorry: snub-nose cab, tall painted cargo body, tandem rear axles, tailboard text */
function buildLorry(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  dark: THREE.Material,
  black: THREE.Material,
  pillar: THREE.Material,
  chrome: THREE.Material,
  glass: THREE.Material,
  glassDark: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  L: number,
  W: number,
  H: number,
) {
  const cabLen = 2.1;
  const cabZ = L / 2 - cabLen / 2 - 0.1;
  const cabH = H * 0.78;
  // Chassis rail + bumper
  box(W * 0.9, 0.22, L * 0.96, black, 0, 0.55, -0.1);
  box(W * 1.04, 0.26, 0.22, chrome, 0, 0.42, L / 2 - 0.02);
  // Cab (snub nose, slightly narrower than body)
  box(W * 0.94, cabH * 0.42, cabLen, paint, 0, 0.55 + cabH * 0.26, cabZ);
  box(W * 0.9, cabH * 0.34, cabLen * 0.92, paint, 0, 0.55 + cabH * 0.64, cabZ - 0.05); // upper cab
  box(W * 0.92, 0.1, cabLen * 0.92, dark, 0, 0.55 + cabH * 0.48, cabZ - 0.05); // belt line
  box(W * 0.94, 0.14, cabLen * 0.98, dark, 0, 0.55 + cabH * 0.82, cabZ - 0.05); // cab roof
  // Sun visor (classic)
  const visor = box(W * 0.98, 0.06, 0.45, dark, 0, 0.55 + cabH * 0.8, cabZ + cabLen / 2 + 0.1);
  visor.rotation.x = 0.25;
  // Pillars + glass
  for (const x of [-W * 0.43, W * 0.43]) {
    box(0.08, cabH * 0.3, 0.1, pillar, x, 0.55 + cabH * 0.64, cabZ + cabLen * 0.44);
    box(0.08, cabH * 0.3, 0.1, pillar, x, 0.55 + cabH * 0.64, cabZ - cabLen * 0.42);
  }
  box(W * 0.8, cabH * 0.28, 0.06, glass, 0, 0.55 + cabH * 0.64, cabZ + cabLen / 2 - 0.02);
  box(0.05, cabH * 0.26, cabLen * 0.6, glass, W * 0.46, 0.55 + cabH * 0.64, cabZ);
  box(0.05, cabH * 0.26, cabLen * 0.6, glass, -W * 0.46, 0.55 + cabH * 0.64, cabZ);
  void glassDark;
  // Driver (right-hand drive)
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x3e2723, roughness: 0.9 });
  box(0.4, 0.34, 0.12, seatMat, -W * 0.22, 0.55 + cabH * 0.5, cabZ - 0.3);
  addDriver(g, -W * 0.22, 0.55 + cabH * 0.44, cabZ - 0.1, 0.55 + cabH * 0.8, true);
  // Cargo body: tall wooden-style box with vertical plank ribs
  const bodyLen = L - cabLen - 0.45;
  const bodyZ = cabZ - cabLen / 2 - 0.15 - bodyLen / 2;
  const bodyH = H - 0.6;
  box(W, bodyH, bodyLen, paint, 0, 0.6 + bodyH / 2, bodyZ);
  box(W * 1.01, 0.12, bodyLen * 1.01, dark, 0, 0.6 + bodyH - 0.06, bodyZ); // top rail
  box(W * 1.01, 0.16, bodyLen * 1.01, dark, 0, 0.6 + 0.08, bodyZ); // bottom rail
  const ribs = Math.max(4, Math.round(bodyLen / 0.9));
  for (let i = 0; i <= ribs; i++) {
    const z = bodyZ - bodyLen / 2 + (i / ribs) * bodyLen;
    box(0.06, bodyH, 0.1, dark, W * 0.5, 0.6 + bodyH / 2, z);
    box(0.06, bodyH, 0.1, dark, -W * 0.5, 0.6 + bodyH / 2, z);
  }
  // Tarp bulge on top
  const tarp = new THREE.MeshStandardMaterial({ color: 0x4e342e, roughness: 0.95 });
  box(W * 0.9, 0.35, bodyLen * 0.9, tarp, 0, 0.6 + bodyH + 0.14, bodyZ);
  // Tailboard sign
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 96;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#fff3c4";
  ctx.fillRect(0, 0, 256, 96);
  ctx.strokeStyle = "#c62828";
  ctx.lineWidth = 6;
  ctx.strokeRect(4, 4, 248, 88);
  ctx.fillStyle = "#1a237e";
  ctx.font = "bold 30px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("HORN OK", 128, 32);
  ctx.fillStyle = "#c62828";
  ctx.fillText("PLEASE", 128, 66);
  const tex = new THREE.CanvasTexture(canvas);
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(W * 0.7, bodyH * 0.3), new THREE.MeshBasicMaterial({ map: tex }));
  sign.position.set(0, 0.6 + bodyH * 0.55, bodyZ - bodyLen / 2 - 0.02);
  sign.rotation.y = Math.PI;
  g.add(sign);
  // Mudguards, lights
  for (const x of [-W * 0.34, W * 0.34]) {
    box(0.3, 0.2, 0.08, head, x, 0.75, L / 2 + 0.04);
    box(0.26, 0.18, 0.08, tail, x, 0.78, -L / 2 - 0.02);
  }
  box(W * 0.3, 0.08, 0.1, chrome, 0, 0.55 + cabH * 0.26, L / 2 + 0.02); // grille bar
}

function buildBus(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  dark: THREE.Material,
  black: THREE.Material,
  pillar: THREE.Material,
  chrome: THREE.Material,
  glass: THREE.Material,
  glassDark: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  L: number,
  W: number,
  H: number,
) {
  // Body shell
  box(W, H * 0.55, L, paint, 0, H * 0.38, 0);
  box(W * 0.98, 0.12, L * 0.98, paint, 0, H * 0.78, 0); // roof
  box(W * 0.98, 0.1, L * 0.98, dark, 0, H * 0.55, 0); // window belt

  // Window pillars along the sides
  const winY = H * 0.68;
  const winH = H * 0.22;
  for (let i = -3; i <= 3; i++) {
    const z = (i / 3.5) * (L * 0.4);
    box(0.06, winH + 0.05, 0.08, pillar, W * 0.49, winY, z);
    box(0.06, winH + 0.05, 0.08, pillar, -W * 0.49, winY, z);
  }
  // Side window panes between pillars
  for (let i = -3; i <= 2; i++) {
    const z = ((i + 0.5) / 3.5) * (L * 0.4);
    box(0.04, winH, L * 0.11, glass, W * 0.5, winY, z);
    box(0.04, winH, L * 0.11, glass, -W * 0.5, winY, z);
  }
  // Front windshield (large)
  const ws = box(W * 0.88, H * 0.35, 0.08, glass, 0, H * 0.62, L / 2 - 0.08);
  ws.rotation.x = -0.12;
  // Rear window
  box(W * 0.8, H * 0.28, 0.06, glassDark, 0, H * 0.65, -L / 2 + 0.08);

  // Interior seats row hint + driver
  const seatMat = new THREE.MeshStandardMaterial({ color: 0x455a64, roughness: 0.85 });
  for (let i = -2; i <= 2; i++) {
    box(W * 0.32, 0.28, 0.1, seatMat, -W * 0.28, H * 0.48, i * 1.1);
    box(W * 0.32, 0.28, 0.1, seatMat, W * 0.28, H * 0.48, i * 1.1);
  }
  const busRoof = H * 0.78;
  addDriver(g, -W * 0.28, H * 0.4, L * 0.32, busRoof - 0.1, true);
  addDriver(g, W * 0.28, H * 0.4, 0.2, busRoof - 0.1, false);
  addDriver(g, -W * 0.28, H * 0.4, -1.2, busRoof - 0.1, false);

  box(W * 1.02, 0.2, 0.2, chrome, 0, 0.35, L / 2 - 0.05);
  box(W * 1.02, 0.2, 0.2, chrome, 0, 0.35, -L / 2 + 0.05);
  for (const x of [-W * 0.35, W * 0.35]) {
    box(0.3, 0.18, 0.08, head, x, 0.55, L / 2 + 0.02);
    box(0.28, 0.16, 0.08, tail, x, 0.55, -L / 2 - 0.02);
  }
  void black;
}

/** Black stripe + SCHOOL lettering for yellow school buses */
function decorateSchoolBus(g: THREE.Group, L: number, W: number, H: number) {
  const stripe = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
  const s1 = new THREE.Mesh(new THREE.BoxGeometry(W * 1.01, 0.14, L * 0.92), stripe);
  s1.position.set(0, H * 0.28, 0);
  g.add(s1);
  const s2 = new THREE.Mesh(new THREE.BoxGeometry(W * 1.01, 0.1, L * 0.92), stripe);
  s2.position.set(0, H * 0.72, 0);
  g.add(s2);

  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = "#ffc107";
  ctx.fillRect(0, 0, 256, 64);
  ctx.fillStyle = "#111";
  ctx.font = "bold 36px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("SCHOOL", 128, 34);
  const tex = new THREE.CanvasTexture(canvas);
  const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true });
  const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.7), mat);
  sign.position.set(W * 0.51, H * 0.42, L * 0.05);
  sign.rotation.y = Math.PI / 2;
  g.add(sign);
  const signL = sign.clone();
  signL.position.x = -W * 0.51;
  signL.rotation.y = -Math.PI / 2;
  g.add(signL);

  // Stop-arm hint (folded)
  const arm = new THREE.Mesh(
    new THREE.BoxGeometry(0.08, 0.55, 0.55),
    new THREE.MeshStandardMaterial({ color: 0xc62828, roughness: 0.6 }),
  );
  arm.position.set(W * 0.52, H * 0.55, L * 0.15);
  g.add(arm);
}

/**
 * Seated person fitted under `maxHeadY` so the head never pops through the roof.
 * `seatY` = hip / seat height.
 */
function addDriver(
  g: THREE.Group,
  x: number,
  seatY: number,
  z: number,
  maxHeadY: number,
  withWheel = true,
) {
  const skin = new THREE.MeshStandardMaterial({ color: pick(SKIN_TONES), roughness: 0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color: pick(SHIRT_COLORS), roughness: 0.8 });
  const hair = new THREE.MeshStandardMaterial({ color: pick(HAIR_COLORS), roughness: 0.9 });

  // Unit figure: head top ≈ seatY + 0.48 * scale — shrink to clear roof
  const room = Math.max(0.28, maxHeadY - seatY);
  const s = Math.min(0.82, Math.max(0.52, room / 0.5));

  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.3 * s, 0.3 * s, 0.2 * s), shirt);
  torso.position.set(x, seatY + 0.14 * s, z);
  torso.castShadow = true;
  g.add(torso);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * s, 10, 8), skin);
  head.position.set(x, seatY + 0.36 * s, z + 0.02 * s);
  head.castShadow = true;
  g.add(head);

  const hairM = new THREE.Mesh(new THREE.SphereGeometry(0.115 * s, 10, 8), hair);
  hairM.position.set(x, seatY + 0.4 * s, z - 0.01 * s);
  hairM.scale.set(1, 0.65, 1);
  g.add(hairM);

  const armL = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.07 * s, 0.24 * s), shirt);
  armL.position.set(x - 0.16 * s, seatY + 0.16 * s, z + 0.14 * s);
  armL.rotation.x = -0.45;
  g.add(armL);
  const armR = new THREE.Mesh(new THREE.BoxGeometry(0.07 * s, 0.07 * s, 0.24 * s), shirt);
  armR.position.set(x + 0.16 * s, seatY + 0.16 * s, z + 0.14 * s);
  armR.rotation.x = -0.45;
  g.add(armR);

  if (withWheel) {
    const wheel = new THREE.Mesh(
      new THREE.TorusGeometry(0.1 * s, 0.018 * s, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.6 }),
    );
    wheel.position.set(x, seatY + 0.2 * s, z + 0.28 * s);
    wheel.rotation.x = Math.PI / 2.4;
    g.add(wheel);
  }
}

function buildBike(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  dark: THREE.Material,
  black: THREE.Material,
  chrome: THREE.Material,
  rubber: THREE.Material,
  rim: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  L: number,
  _W: number,
  H: number,
  wheels: THREE.Object3D[],
) {
  const wr = 0.32;
  box(0.12, 0.14, L * 0.55, paint, 0, 0.55, 0);
  box(0.1, 0.35, 0.12, dark, 0, 0.75, L * 0.12);
  box(0.28, 0.22, 0.55, paint, 0, 0.72, 0.05);
  box(0.28, 0.1, 0.45, black, 0, 0.78, -0.35);
  box(0.22, 0.25, 0.35, chrome, 0, 0.42, -0.05);
  box(0.7, 0.06, 0.06, chrome, 0, 1.05, L * 0.28);
  box(0.08, 0.2, 0.08, chrome, 0, 0.95, L * 0.28);
  box(0.16, 0.14, 0.1, head, 0, 0.85, L * 0.35);
  box(0.12, 0.1, 0.08, tail, 0, 0.7, -L * 0.4);
  const exhaust = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.045, 0.7, 8), chrome);
  exhaust.rotation.x = Math.PI / 2;
  exhaust.position.set(0.18, 0.35, -0.25);
  g.add(exhaust);

  // Rider with helmet
  const skin = new THREE.MeshStandardMaterial({ color: pick(SKIN_TONES), roughness: 0.85 });
  const jacket = new THREE.MeshStandardMaterial({ color: pick(SHIRT_COLORS), roughness: 0.8 });
  box(0.32, 0.4, 0.22, jacket, 0, 1.05, -0.15);
  const headMesh = new THREE.Mesh(new THREE.SphereGeometry(0.14, 10, 8), skin);
  headMesh.position.set(0, 1.4, -0.05);
  headMesh.castShadow = true;
  g.add(headMesh);
  const helmet = new THREE.Mesh(
    new THREE.SphereGeometry(0.16, 10, 8),
    new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5, metalness: 0.3 }),
  );
  helmet.position.set(0, 1.45, -0.05);
  helmet.scale.set(1, 0.85, 1.05);
  g.add(helmet);
  // Visor glass
  const visor = new THREE.Mesh(
    new THREE.SphereGeometry(0.12, 8, 6, 0, Math.PI * 2, 0, Math.PI * 0.45),
    new THREE.MeshStandardMaterial({
      color: 0x88ccee,
      transparent: true,
      opacity: 0.45,
      roughness: 0.1,
      metalness: 0.5,
    }),
  );
  visor.position.set(0, 1.42, 0.06);
  g.add(visor);
  box(0.12, 0.35, 0.14, black, 0.12, 0.7, -0.2);
  box(0.12, 0.35, 0.14, black, -0.12, 0.7, -0.2);

  for (const z of [L * 0.32, -L * 0.32]) {
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, 0.16, 16), rubber);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    wheel.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(wr * 0.4, wr * 0.4, 0.18, 10), rim);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    for (let i = 0; i < 4; i++) {
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.03, wr * 1.5, 0.03), chrome);
      spoke.rotation.z = (i / 4) * Math.PI;
      wheel.add(spoke);
    }
    wheel.position.set(0, wr, z);
    g.add(wheel);
    wheels.push(wheel);
  }

  void H;
}

/** Indian three-wheeler auto-rickshaw: single front wheel, black canopy, open sides, driver + passenger */
function buildAuto(
  g: THREE.Group,
  box: BoxFn,
  paint: THREE.Material,
  black: THREE.Material,
  chrome: THREE.Material,
  rubber: THREE.Material,
  rim: THREE.Material,
  glass: THREE.Material,
  head: THREE.Material,
  tail: THREE.Material,
  L: number,
  W: number,
  H: number,
  wheels: THREE.Object3D[],
) {
  const canopy = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
  const floorY = 0.42;
  // Floor pan + lower body (yellow)
  box(W * 0.92, 0.1, L * 0.78, paint, 0, floorY, -L * 0.06);
  box(W * 0.92, 0.42, L * 0.5, paint, 0, floorY + 0.22, -L * 0.2); // rear tub
  box(W * 0.9, 0.3, 0.12, paint, 0, floorY + 0.55, -L * 0.45); // rear panel
  // Front cowl (tapered nose) + mudguard over the single front wheel
  box(W * 0.55, 0.5, 0.5, paint, 0, floorY + 0.25, L * 0.3);
  box(W * 0.3, 0.26, 0.74, paint, 0, floorY + 0.12, L * 0.42);
  // Windscreen frame + glass
  box(W * 0.78, 0.04, 0.05, chrome, 0, floorY + 1.18, L * 0.26);
  box(W * 0.78, 0.6, 0.03, glass, 0, floorY + 0.88, L * 0.27);
  // Canopy pillars + black hood
  for (const sx of [-1, 1]) {
    box(0.05, 0.9, 0.05, black, sx * W * 0.44, floorY + 0.85, L * 0.24);
    box(0.05, 0.75, 0.05, black, sx * W * 0.44, floorY + 0.9, -L * 0.42);
  }
  box(W * 0.98, 0.08, L * 0.76, canopy, 0, floorY + 1.3, -L * 0.1);
  box(0.05, 0.75, L * 0.58, canopy, -W * 0.47, floorY + 0.9, -L * 0.2); // rear-side curtain (left)
  box(0.05, 0.75, L * 0.58, canopy, W * 0.47, floorY + 0.9, -L * 0.2);
  // Handlebar + meter
  box(0.55, 0.05, 0.05, chrome, 0, floorY + 0.75, L * 0.18);
  box(0.12, 0.1, 0.1, black, 0, floorY + 0.72, L * 0.22);
  // Bench seats
  box(W * 0.8, 0.12, 0.4, black, 0, floorY + 0.3, -L * 0.22);
  box(0.4, 0.1, 0.32, black, 0, floorY + 0.36, L * 0.02);
  // Lights
  box(0.22, 0.2, 0.08, head, 0, floorY + 0.5, L * 0.5);
  box(0.18, 0.09, 0.06, tail, -W * 0.3, floorY + 0.5, -L * 0.5);
  box(0.18, 0.09, 0.06, tail, W * 0.3, floorY + 0.5, -L * 0.5);

  // Driver (front, centre) and a passenger
  const skin = new THREE.MeshStandardMaterial({ color: pick(SKIN_TONES), roughness: 0.85 });
  const shirt = new THREE.MeshStandardMaterial({ color: 0xcfd8dc, roughness: 0.8 }); // khaki/grey uniform
  const pShirt = new THREE.MeshStandardMaterial({ color: pick(SHIRT_COLORS), roughness: 0.8 });
  box(0.36, 0.42, 0.26, shirt, 0, floorY + 0.62, L * 0.03);
  const dHead = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skin);
  dHead.position.set(0, floorY + 0.98, L * 0.03);
  g.add(dHead);
  box(0.38, 0.4, 0.26, pShirt, -0.22, floorY + 0.6, -L * 0.22);
  const pHead = new THREE.Mesh(new THREE.SphereGeometry(0.13, 10, 8), skin);
  pHead.position.set(-0.22, floorY + 0.94, -L * 0.22);
  g.add(pHead);

  // Three wheels: one front centre, two rear
  const wr = 0.3;
  const spots: [number, number][] = [
    [0, L * 0.42],
    [W / 2 - 0.02, -L * 0.3],
    [-W / 2 + 0.02, -L * 0.3],
  ];
  for (const [x, z] of spots) {
    const wheel = new THREE.Group();
    const tire = new THREE.Mesh(new THREE.CylinderGeometry(wr, wr, 0.18, 14), rubber);
    tire.rotation.z = Math.PI / 2;
    tire.castShadow = true;
    wheel.add(tire);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(wr * 0.5, wr * 0.5, 0.2, 10), rim);
    hub.rotation.z = Math.PI / 2;
    wheel.add(hub);
    wheel.position.set(x, wr, z);
    g.add(wheel);
    wheels.push(wheel);
  }
  void H;
}

export function spinWheels(mesh: THREE.Group, speed: number, dt: number) {
  const wheels = mesh.userData.wheels as THREE.Object3D[] | undefined;
  if (!wheels) return;
  const ang = (speed / 0.36) * dt;
  for (const w of wheels) w.rotation.x += ang;
}

/** Real-looking reserved parking bay: painted bay, kerb stones, bollards, blue "P" sign with beacon */
export function createMarkerMesh(): THREE.Group {
  const g = new THREE.Group();
  const BAY_W = 5.2;
  const BAY_L = 8.6;

  const flat = (w: number, d: number, mat: THREE.Material, x: number, y: number, z: number) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, d), mat);
    m.rotation.x = -Math.PI / 2;
    m.position.set(x, y, z);
    m.receiveShadow = true;
    g.add(m);
    return m;
  };

  // Fresh asphalt pad with a warm yellow wash so it reads from far away
  flat(BAY_W + 1.6, BAY_L + 1.6, new THREE.MeshStandardMaterial({ color: 0x2a2d31, roughness: 0.95 }), 0, 0.03, 0);
  const wash = flat(
    BAY_W,
    BAY_L,
    new THREE.MeshStandardMaterial({
      color: 0xffd54a,
      emissive: 0xffa000,
      emissiveIntensity: 0.25,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
    }),
    0,
    0.05,
    0,
  );
  void wash;

  // Painted bay: two side lines, rear line, hatched entrance ticks
  const paintMat = new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide });
  const lw = 0.16;
  flat(lw, BAY_L, paintMat, -BAY_W / 2, 0.07, 0);
  flat(lw, BAY_L, paintMat, BAY_W / 2, 0.07, 0);
  flat(BAY_W + lw, lw, paintMat, 0, 0.07, -BAY_L / 2);
  for (let i = -2; i <= 2; i++) flat(0.7, lw, paintMat, i * (BAY_W / 5), 0.07, BAY_L / 2 - 0.4);

  // Yellow hatched "keep clear" apron in front of the bay
  const hatch = new THREE.MeshBasicMaterial({ color: 0xffd54a, side: THREE.DoubleSide, transparent: true, opacity: 0.9 });
  for (let i = -3; i <= 3; i++) {
    const h = flat(0.18, 2.6, hatch, i * 0.75, 0.065, BAY_L / 2 + 1.6);
    h.rotation.z = Math.PI / 4;
  }

  // Big "P" and "RESERVED" painted on the floor
  const pCanvas = document.createElement("canvas");
  pCanvas.width = 256;
  pCanvas.height = 384;
  const ctx = pCanvas.getContext("2d")!;
  ctx.fillStyle = "#ffffff";
  ctx.font = "bold 220px sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText("P", 128, 150);
  ctx.font = "bold 46px sans-serif";
  ctx.fillText("RESERVED", 128, 320);
  const pTex = new THREE.CanvasTexture(pCanvas);
  flat(3.0, 4.5, new THREE.MeshBasicMaterial({ map: pTex, transparent: true }), 0, 0.08, -0.4);

  // Kerb stones around three sides (yellow/black alternating)
  const kerbY = new THREE.MeshStandardMaterial({ color: 0xffc107, roughness: 0.7 });
  const kerbK = new THREE.MeshStandardMaterial({ color: 0x1b1b1b, roughness: 0.7 });
  const kerb = (w: number, d: number, x: number, z: number, i: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, 0.22, d), i % 2 ? kerbK : kerbY);
    m.position.set(x, 0.11, z);
    m.castShadow = true;
    g.add(m);
  };
  const segs = 8;
  for (let i = 0; i < segs; i++) {
    const z = -BAY_L / 2 + (i + 0.5) * (BAY_L / segs);
    kerb(0.3, BAY_L / segs - 0.04, -BAY_W / 2 - 0.55, z, i);
    kerb(0.3, BAY_L / segs - 0.04, BAY_W / 2 + 0.55, z, i + 1);
  }
  for (let i = 0; i < 6; i++) {
    const x = -BAY_W / 2 - 0.55 + (i + 0.5) * ((BAY_W + 1.1) / 6);
    kerb((BAY_W + 1.1) / 6 - 0.04, 0.3, x, -BAY_L / 2 - 0.55, i);
  }

  // Bollards with reflective bands at the rear corners
  const bollardMat = new THREE.MeshStandardMaterial({ color: 0x9aa4b0, metalness: 0.7, roughness: 0.35 });
  const bandMat = new THREE.MeshStandardMaterial({ color: 0xff3b30, emissive: 0xff1744, emissiveIntensity: 0.5 });
  for (const sx of [-1, 1]) {
    const b = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.12, 0.9, 10), bollardMat);
    b.position.set(sx * (BAY_W / 2 + 0.55), 0.45, -BAY_L / 2 - 0.55);
    b.castShadow = true;
    g.add(b);
    const band = new THREE.Mesh(new THREE.CylinderGeometry(0.11, 0.11, 0.14, 10), bandMat);
    band.position.set(sx * (BAY_W / 2 + 0.55), 0.75, -BAY_L / 2 - 0.55);
    g.add(band);
  }

  // Wheel stop at the back of the bay
  const stop = new THREE.Mesh(
    new THREE.BoxGeometry(2.0, 0.14, 0.3),
    new THREE.MeshStandardMaterial({ color: 0xe0e0e0, roughness: 0.8 }),
  );
  stop.position.set(0, 0.07, -BAY_L / 2 + 1.1);
  g.add(stop);

  // Blue international parking sign on a post, with a slow-pulsing beacon on top
  const post = new THREE.Mesh(
    new THREE.CylinderGeometry(0.07, 0.09, 4.2, 10),
    new THREE.MeshStandardMaterial({ color: 0x6b7480, metalness: 0.6, roughness: 0.4 }),
  );
  post.position.set(BAY_W / 2 + 1.1, 2.1, -BAY_L / 2 - 0.2);
  post.castShadow = true;
  g.add(post);

  const signCanvas = document.createElement("canvas");
  signCanvas.width = 256;
  signCanvas.height = 256;
  const sctx = signCanvas.getContext("2d")!;
  sctx.fillStyle = "#0b57d0";
  sctx.fillRect(0, 0, 256, 256);
  sctx.strokeStyle = "#ffffff";
  sctx.lineWidth = 14;
  sctx.strokeRect(10, 10, 236, 236);
  sctx.fillStyle = "#ffffff";
  sctx.font = "bold 190px sans-serif";
  sctx.textAlign = "center";
  sctx.textBaseline = "middle";
  sctx.fillText("P", 128, 140);
  const signTex = new THREE.CanvasTexture(signCanvas);
  const sign = new THREE.Mesh(
    new THREE.BoxGeometry(1.5, 1.5, 0.06),
    [
      bollardMat,
      bollardMat,
      bollardMat,
      bollardMat,
      new THREE.MeshStandardMaterial({ map: signTex, emissive: 0x0b57d0, emissiveMap: signTex, emissiveIntensity: 0.35 }),
      new THREE.MeshStandardMaterial({ map: signTex, emissive: 0x0b57d0, emissiveMap: signTex, emissiveIntensity: 0.35 }),
    ],
  );
  sign.position.set(BAY_W / 2 + 1.1, 3.5, -BAY_L / 2 - 0.2);
  sign.rotation.y = Math.PI / 2;
  g.add(sign);

  const beacon = new THREE.Mesh(
    new THREE.SphereGeometry(0.32, 16, 12),
    new THREE.MeshStandardMaterial({ color: 0x4fc3f7, emissive: 0x29b6f6, emissiveIntensity: 1.2 }),
  );
  beacon.position.set(BAY_W / 2 + 1.1, 4.55, -BAY_L / 2 - 0.2);
  g.add(beacon);

  // Tall slim light mast so the bay is visible from blocks away
  const mast = new THREE.Mesh(
    new THREE.CylinderGeometry(0.06, 0.1, 8, 8),
    new THREE.MeshStandardMaterial({ color: 0xcfd8dc, metalness: 0.6, roughness: 0.4 }),
  );
  mast.position.set(-BAY_W / 2 - 1.1, 4, -BAY_L / 2 - 0.2);
  g.add(mast);
  const lamp = new THREE.Mesh(
    new THREE.BoxGeometry(0.9, 0.18, 0.5),
    new THREE.MeshStandardMaterial({ color: 0xfff8e1, emissive: 0xffe082, emissiveIntensity: 1.0 }),
  );
  lamp.position.set(-BAY_W / 2 - 0.7, 8, -BAY_L / 2 - 0.2);
  g.add(lamp);
  const glow = new THREE.PointLight(0xffe082, 1.6, 22, 1.6);
  glow.position.set(-BAY_W / 2 - 0.7, 7.6, -BAY_L / 2 - 0.2);
  g.add(glow);

  g.userData.beacon = beacon;
  return g;
}
