import * as THREE from "three";

function canvasTexture(
  size: number,
  draw: (ctx: CanvasRenderingContext2D, size: number) => void,
  repeat = 1,
): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const ctx = c.getContext("2d")!;
  draw(ctx, size);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeat, repeat);
  tex.anisotropy = 8;
  return tex;
}

/** Noisy asphalt albedo */
export function makeAsphaltTexture(repeat = 8): THREE.CanvasTexture {
  return canvasTexture(
    512,
    (ctx, s) => {
      ctx.fillStyle = "#3a3e45";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 14000; i++) {
        const x = Math.random() * s;
        const y = Math.random() * s;
        const v = 40 + Math.random() * 50;
        ctx.fillStyle = `rgba(${v},${v + 2},${v + 4},${0.08 + Math.random() * 0.2})`;
        ctx.fillRect(x, y, 1 + Math.random() * 2, 1 + Math.random() * 2);
      }
      // subtle tar streaks
      for (let i = 0; i < 40; i++) {
        ctx.strokeStyle = `rgba(20,20,22,${0.08 + Math.random() * 0.1})`;
        ctx.lineWidth = 1 + Math.random() * 3;
        ctx.beginPath();
        ctx.moveTo(Math.random() * s, Math.random() * s);
        ctx.lineTo(Math.random() * s, Math.random() * s);
        ctx.stroke();
      }
    },
    repeat,
  );
}

export function makeSidewalkTexture(repeat = 6): THREE.CanvasTexture {
  return canvasTexture(
    256,
    (ctx, s) => {
      ctx.fillStyle = "#aab2bc";
      ctx.fillRect(0, 0, s, s);
      const tile = 32;
      for (let y = 0; y < s; y += tile) {
        for (let x = 0; x < s; x += tile) {
          const shade = 155 + Math.random() * 35;
          ctx.fillStyle = `rgb(${shade},${shade + 2},${shade + 6})`;
          ctx.fillRect(x + 1, y + 1, tile - 2, tile - 2);
          ctx.strokeStyle = "rgba(90,95,105,0.35)";
          ctx.strokeRect(x + 0.5, y + 0.5, tile - 1, tile - 1);
        }
      }
    },
    repeat,
  );
}

export function makeGrassTexture(repeat = 20): THREE.CanvasTexture {
  return canvasTexture(
    256,
    (ctx, s) => {
      ctx.fillStyle = "#3a8f45";
      ctx.fillRect(0, 0, s, s);
      for (let i = 0; i < 8000; i++) {
        const g = 80 + Math.random() * 90;
        ctx.fillStyle = `rgb(${30 + Math.random() * 40},${g},${30 + Math.random() * 30})`;
        ctx.fillRect(Math.random() * s, Math.random() * s, 2, 2);
      }
    },
    repeat,
  );
}

/** Building facade with window grid */
export function makeBuildingTexture(seed = Math.random()): THREE.CanvasTexture {
  return canvasTexture(256, (ctx, s) => {
    const baseH = 150 + Math.floor(seed * 60);
    const baseS = 20 + Math.floor(seed * 40);
    const baseL = 55 + Math.floor(seed * 25);
    ctx.fillStyle = `hsl(${baseH}, ${baseS}%, ${baseL}%)`;
    ctx.fillRect(0, 0, s, s);

    // concrete bands
    for (let y = 0; y < s; y += 28) {
      ctx.fillStyle = "rgba(0,0,0,0.08)";
      ctx.fillRect(0, y, s, 3);
    }

    const winW = 14;
    const winH = 18;
    for (let y = 18; y < s - 20; y += 28) {
      for (let x = 12; x < s - 12; x += 22) {
        const lit = Math.sin(seed * 40 + x * 0.4 + y * 0.25) > 0.15;
        if (lit) {
          ctx.fillStyle = `rgba(${180 + Math.random() * 60},${200 + Math.random() * 40},${220},0.95)`;
        } else {
          ctx.fillStyle = "rgba(30,45,60,0.85)";
        }
        ctx.fillRect(x, y, winW, winH);
        ctx.strokeStyle = "rgba(20,20,25,0.45)";
        ctx.strokeRect(x + 0.5, y + 0.5, winW - 1, winH - 1);
      }
    }
  });
}

export function asphaltMaterial(): THREE.MeshStandardMaterial {
  const map = makeAsphaltTexture(14);
  return new THREE.MeshStandardMaterial({
    map,
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.04,
  });
}

export function sidewalkMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: makeSidewalkTexture(10),
    roughness: 0.88,
    metalness: 0.02,
  });
}

export function grassMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    map: makeGrassTexture(24),
    roughness: 0.95,
    metalness: 0,
  });
}

export function buildingMaterial(seed?: number): THREE.MeshStandardMaterial {
  const map = makeBuildingTexture(seed ?? Math.random());
  map.wrapS = map.wrapT = THREE.RepeatWrapping;
  map.repeat.set(1, 1);
  return new THREE.MeshStandardMaterial({
    map,
    roughness: 0.78,
    metalness: 0.08,
  });
}
