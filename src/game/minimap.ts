import { BLOCK } from "./constants";
import type { Vehicle } from "./vehicle";
import type { CityWorld } from "./world";

/**
 * Heading-up mini-map (Dr. Driving style):
 * - Player stays centered, tip always points "up" (forward)
 * - World rotates under the player by −yaw
 * - Route line to destination + named-area marker
 */
export class MiniMap {
  private canvas: HTMLCanvasElement;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.canvas.width = 148;
    this.canvas.height = 148;
  }

  draw(player: Vehicle, world: CityWorld) {
    const ctx = this.canvas.getContext("2d");
    if (!ctx) return;
    const S = this.canvas.width;
    const cx = S / 2;
    const cy = S / 2;
    const viewR = BLOCK * 2.35;
    const scale = (S * 0.42) / viewR;

    const yaw = player.yaw;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);

    const toMap = (x: number, z: number) => {
      const dx = x - player.position.x;
      const dz = z - player.position.z;
      const localRight = dx * cos - dz * sin;
      const localFwd = dx * sin + dz * cos;
      return {
        mx: cx - localRight * scale,
        my: cy - localFwd * scale,
      };
    };

    ctx.clearRect(0, 0, S, S);

    ctx.fillStyle = "#141c28";
    roundRect(ctx, 0, 0, S, S, 14);
    ctx.fill();

    ctx.save();
    roundRect(ctx, 4, 4, S - 8, S - 8, 12);
    ctx.clip();

    ctx.fillStyle = "#2a5230";
    ctx.fillRect(4, 4, S - 8, S - 8);

    const grd = ctx.createRadialGradient(cx, cy, S * 0.15, cx, cy, S * 0.55);
    grd.addColorStop(0, "rgba(0,0,0,0)");
    grd.addColorStop(1, "rgba(10,14,20,0.35)");
    ctx.fillStyle = grd;
    ctx.fillRect(4, 4, S - 8, S - 8);

    const xs = world.xs.length ? world.xs : [];
    const zs = world.zs.length ? world.zs : [];
    const minX = xs[0] ?? -300;
    const maxX = xs[xs.length - 1] ?? 300;
    const minZ = zs[0] ?? -300;
    const maxZ = zs[zs.length - 1] ?? 300;

    ctx.strokeStyle = "#5a6270";
    ctx.lineWidth = Math.max(3.2, ROAD_WIDTH_PX(scale));
    ctx.lineCap = "butt";
    for (const p of xs) {
      strokeSeg(ctx, toMap(p, minZ), toMap(p, maxZ));
    }
    for (const p of zs) {
      strokeSeg(ctx, toMap(minX, p), toMap(maxX, p));
    }

    let dest = toMap(world.destination.x, world.destination.z);
    const maxR = S * 0.42;
    const ddx = dest.mx - cx;
    const ddy = dest.my - cy;
    const dlen = Math.hypot(ddx, ddy) || 1;
    if (dlen > maxR) {
      dest = { mx: cx + (ddx / dlen) * maxR, my: cy + (ddy / dlen) * maxR };
    }
    ctx.save();
    ctx.strokeStyle = "rgba(92, 255, 141, 0.85)";
    ctx.lineWidth = 2.2;
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(dest.mx, dest.my);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();

    for (const p of world.places) {
      if (world.destinationPlace && p.bx === world.destinationPlace.bx && p.bz === world.destinationPlace.bz) continue;
      let pt = toMap(p.cx, p.cz);
      const dx = pt.mx - cx;
      const dy = pt.my - cy;
      const len = Math.hypot(dx, dy) || 1;
      if (len > maxR) pt = { mx: cx + (dx / len) * maxR, my: cy + (dy / len) * maxR };
      drawPlace(ctx, pt.mx, pt.my, p.short, false);
    }
    drawPlace(ctx, dest.mx, dest.my, world.destinationPlace?.short ?? "GO", true);

    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = "#42a5f5";
    ctx.strokeStyle = "#ffffff";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.moveTo(0, -8);
    ctx.lineTo(5.5, 7);
    ctx.lineTo(0, 3.5);
    ctx.lineTo(-5.5, 7);
    ctx.closePath();
    ctx.fill();
    ctx.stroke();
    ctx.restore();

    ctx.restore();

    ctx.strokeStyle = "rgba(255,180,0,0.55)";
    ctx.lineWidth = 2;
    roundRect(ctx, 1, 1, S - 2, S - 2, 13);
    ctx.stroke();

    const nR = S * 0.38;
    const nx = cx + Math.sin(yaw) * nR;
    const ny = cy - Math.cos(yaw) * nR;
    ctx.fillStyle = "#ff5252";
    ctx.font = "bold 11px Orbitron, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("N", nx, ny);

    ctx.fillStyle = "rgba(255,255,255,0.7)";
    ctx.font = "bold 9px Rajdhani, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText("MAP", 12, S - 10);
  }
}

function ROAD_WIDTH_PX(scale: number) {
  return 15.2 * scale;
}

function strokeSeg(
  ctx: CanvasRenderingContext2D,
  a: { mx: number; my: number },
  b: { mx: number; my: number },
) {
  ctx.beginPath();
  ctx.moveTo(a.mx, a.my);
  ctx.lineTo(b.mx, b.my);
  ctx.stroke();
}

function drawPlace(ctx: CanvasRenderingContext2D, x: number, y: number, label: string, mission = false) {
  ctx.save();
  ctx.fillStyle = mission ? "#5cff8d" : "rgba(210, 220, 230, 0.88)";
  roundRect(ctx, x - 15, y - 7, 30, 14, 4);
  ctx.fill();
  ctx.strokeStyle = mission ? "#fff" : "rgba(20,30,40,0.45)";
  ctx.lineWidth = 1.2;
  ctx.stroke();
  ctx.fillStyle = mission ? "#102018" : "#1a2330";
  ctx.font = "bold 6.5px Orbitron, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const t = label.length > 8 ? label.slice(0, 8) : label;
  ctx.fillText(t, x, y + 0.5);
  ctx.restore();
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
