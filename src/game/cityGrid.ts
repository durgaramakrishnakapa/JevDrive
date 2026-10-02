import { CITY_BLOCKS } from "./constants";

/**
 * Irregular city axes — some blocks short & cramped, some long enough for 4th gear.
 * Shared by world build + route planner (set once when the city is built).
 */
export type CityAxes = { xs: number[]; zs: number[] };

let active: CityAxes | null = null;

export function setActiveCityGrid(xs: number[], zs: number[]) {
  active = { xs, zs };
}

export function getCityAxes(): CityAxes {
  if (!active) {
    // Fallback uniform grid before world exists
    const xs = makeUniformAxes(CITY_BLOCKS, 100);
    active = { xs, zs: [...xs] };
  }
  return active;
}

export function makeUniformAxes(nBlocks: number, block: number): number[] {
  const half = (nBlocks * block) / 2;
  const out: number[] = [];
  for (let i = 0; i <= nBlocks; i++) out.push(-half + i * block);
  return out;
}

/** Mix of short / medium / long gaps → clumsy, uneven map */
export function makeIrregularAxes(nBlocks: number): number[] {
  const gaps: number[] = [];
  let longs = 0;
  let shorts = 0;
  for (let i = 0; i < nBlocks; i++) {
    const r = Math.random();
    if (r < 0.34) {
      // Short cramped block — 2nd/3rd gear
      gaps.push(48 + Math.random() * 32);
      shorts++;
    } else if (r < 0.62) {
      // Medium
      gaps.push(88 + Math.random() * 42);
    } else {
      // Long boulevard — room to climb into 4th (~175–260 m)
      gaps.push(175 + Math.random() * 90);
      longs++;
    }
  }
  // Guarantee variety
  for (let n = 0; n < 2 && longs < 2; n++) {
    const i = Math.floor(Math.random() * gaps.length);
    if (gaps[i] < 160) {
      gaps[i] = 190 + Math.random() * 70;
      longs++;
    }
  }
  for (let n = 0; n < 2 && shorts < 2; n++) {
    const i = Math.floor(Math.random() * gaps.length);
    if (gaps[i] > 95) {
      gaps[i] = 50 + Math.random() * 22;
      shorts++;
    }
  }

  const total = gaps.reduce((a, b) => a + b, 0);
  let c = -total / 2;
  const coords = [Math.round(c * 10) / 10];
  for (const g of gaps) {
    c += g;
    coords.push(Math.round(c * 10) / 10);
  }
  return coords;
}

export function nearestAxisIndex(coords: number[], v: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < coords.length; i++) {
    const d = Math.abs(coords[i] - v);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

export function clampIndex(i: number): number {
  return Math.max(0, Math.min(CITY_BLOCKS, i));
}

export function coordX(i: number): number {
  return getCityAxes().xs[clampIndex(i)];
}

export function coordZ(j: number): number {
  return getCityAxes().zs[clampIndex(j)];
}

export function indexX(x: number): number {
  return nearestAxisIndex(getCityAxes().xs, x);
}

export function indexZ(z: number): number {
  return nearestAxisIndex(getCityAxes().zs, z);
}

/** Gap length between junction i and i+1 on an axis */
export function gapOn(coords: number[], i: number): number {
  if (i < 0 || i >= coords.length - 1) return 100;
  return Math.abs(coords[i + 1] - coords[i]);
}

export function cityMinX(): number {
  return getCityAxes().xs[0];
}
export function cityMaxX(): number {
  const xs = getCityAxes().xs;
  return xs[xs.length - 1];
}
export function cityMinZ(): number {
  return getCityAxes().zs[0];
}
export function cityMaxZ(): number {
  const zs = getCityAxes().zs;
  return zs[zs.length - 1];
}

export function cityHalfSpan(): number {
  return Math.max(
    Math.abs(cityMinX()),
    Math.abs(cityMaxX()),
    Math.abs(cityMinZ()),
    Math.abs(cityMaxZ()),
  );
}
