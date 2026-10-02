import type { DriveInput, Gear } from "./vehicle";

/**
 * Dr. Driving–style controls:
 * - ArrowUp / W = go straight (no hidden steer)
 * - Left / Right = turn, auto-center on release
 * - Mouse steers ONLY while dragging the on-screen wheel
 */
export class Controls {
  throttle = 0;
  brake = 0;
  steer = 0;
  handbrake = false;
  keys = new Set<string>();

  private wheelSteer = 0;
  private draggingWheel = false;
  private wheelEl: HTMLElement | null = null;
  private gasHeld = false;
  private brakeHeld = false;

  constructor() {
    window.addEventListener("keydown", (e) => {
      this.keys.add(e.code);
      if (
        ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)
      ) {
        e.preventDefault();
      }
    });
    window.addEventListener("keyup", (e) => this.keys.delete(e.code));

    window.addEventListener("mousemove", (e) => {
      if (!this.draggingWheel || !this.wheelEl) return;
      const rect = this.wheelEl.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      // Drag left on wheel → turn left (positive steer in our yaw convention)
      this.wheelSteer = clamp(-(e.clientX - cx) / (rect.width * 0.5), -1, 1);
    });

    window.addEventListener("mouseup", () => this.endWheelDrag());
    window.addEventListener("touchend", () => this.endWheelDrag());

    document.getElementById("game-canvas")?.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
  }

  private endWheelDrag() {
    this.draggingWheel = false;
    // Snap wheel input back; keyboard may still hold steer
    this.wheelSteer = 0;
  }

  bindHud() {
    this.wheelEl = document.getElementById("steering-wheel");
    const gas = document.getElementById("pedal-gas");
    const brake = document.getElementById("pedal-brake");

    const press = (el: HTMLElement | null, on: () => void, off: () => void) => {
      if (!el) return;
      const start = (e: Event) => {
        e.preventDefault();
        e.stopPropagation();
        el.classList.add("pressed");
        on();
      };
      const end = () => {
        el.classList.remove("pressed");
        off();
      };
      el.addEventListener("mousedown", start);
      el.addEventListener("touchstart", start, { passive: false });
      window.addEventListener("mouseup", end);
      window.addEventListener("touchend", end);
    };

    press(
      gas,
      () => {
        this.gasHeld = true;
        this.throttle = 1;
      },
      () => {
        this.gasHeld = false;
        if (!this.keys.has("KeyW") && !this.keys.has("ArrowUp")) this.throttle = 0;
      },
    );
    press(
      brake,
      () => {
        this.brakeHeld = true;
        this.brake = 1;
      },
      () => {
        this.brakeHeld = false;
        if (!this.keys.has("KeyS") && !this.keys.has("ArrowDown")) this.brake = 0;
      },
    );

    const startWheel = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      this.draggingWheel = true;
      document.body.classList.add("steering");
    };
    this.wheelEl?.addEventListener("mousedown", startWheel);
    this.wheelEl?.addEventListener("touchstart", startWheel, { passive: false });
    window.addEventListener("mouseup", () => document.body.classList.remove("steering"));
    window.addEventListener("touchend", () => document.body.classList.remove("steering"));
  }

  sample(): DriveInput {
    let throttle = this.gasHeld ? 1 : 0;
    let brake = this.brakeHeld ? 1 : 0;
    let steer = 0;

    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) throttle = 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) brake = 1;

    // Keyboard steer (screen / driver view: left key → turn left)
    const left = this.keys.has("KeyA") || this.keys.has("ArrowLeft");
    const right = this.keys.has("KeyD") || this.keys.has("ArrowRight");
    if (left && !right) steer = 1;
    else if (right && !left) steer = -1;
    else if (this.draggingWheel) steer = this.wheelSteer;
    // else steer stays 0 → car goes straight

    this.handbrake = this.keys.has("Space");
    this.throttle = throttle;
    this.brake = brake;
    this.steer = steer;

    return {
      throttle,
      brake,
      steer,
      handbrake: this.handbrake,
    };
  }

  consumeGearKeys(current: Gear): Gear | null {
    const order: Gear[] = ["P", "R", "N", "1", "2", "3", "4", "5"];
    const i = order.indexOf(current);
    if (this.keys.has("KeyE")) {
      this.keys.delete("KeyE");
      return order[Math.min(order.length - 1, i + 1)];
    }
    if (this.keys.has("KeyQ")) {
      this.keys.delete("KeyQ");
      return order[Math.max(0, i - 1)];
    }
    // Number keys 1-5 for direct gear
    for (let g = 1; g <= 5; g++) {
      const code = `Digit${g}`;
      if (this.keys.has(code)) {
        this.keys.delete(code);
        return String(g) as Gear;
      }
    }
    return null;
  }

  /** H = horn (edge-triggered) */
  consumeHorn(): boolean {
    if (this.keys.has("KeyH")) {
      this.keys.delete("KeyH");
      return true;
    }
    return false;
  }

  consumeCameraToggle(): boolean {
    if (this.keys.has("KeyC")) {
      this.keys.delete("KeyC");
      return true;
    }
    return false;
  }
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}
