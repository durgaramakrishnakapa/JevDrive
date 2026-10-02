import {
  LANE_WIDTH,
  PED_COUNT,
  PLAYER_COLOR,
  ROAD_WIDTH,
  STOP_LINE_SETBACK,
} from "./constants";
import { getCityAxes } from "./cityGrid";
import { Controls } from "./controls";
import { TrafficSystem } from "./traffic";
import { poseOnRoad } from "./lanes";
import { PedestrianSystem } from "./pedestrians";
import { MiniMap } from "./minimap";
import { Vehicle, type Gear } from "./vehicle";
import { CityWorld } from "./world";
import { AutoDriver } from "./autoDriver";
import { approachSignalAxis, buildDriveState } from "./driveSense";
import { insideJunctionBox } from "./routePlanner";
import { distToPlace } from "./places";
import { CarAudio } from "./carAudio";
import * as THREE from "three";

type Phase = "menu" | "playing" | "parked" | "won" | "crashed" | "out_of_fuel";

/** Seconds the "PARKING SUCCESSFUL" banner stays before the result card */
const PARKED_HOLD_S = 2.5;
/** H-gate cell (col 1–4, row 1–3) matching the rectangular gearbox plate */
const GEAR_POS: Record<Gear, [number, number]> = {
  P: [1, 1],
  "1": [2, 1],
  "3": [3, 1],
  "5": [4, 1],
  N: [3, 2],
  "2": [2, 3],
  "4": [3, 3],
  R: [4, 3],
};

export class Game {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(55, 1, 0.1, 600);
  world: CityWorld;
  player: Vehicle;
  traffic: TrafficSystem;
  pedestrians: PedestrianSystem;
  minimap: MiniMap | null = null;
  controls = new Controls();
  autoDriver = new AutoDriver();
  carAudio = new CarAudio();
  clock = new THREE.Clock();
  phase: Phase = "menu";
  cameraMode = 0; // 0 medium, 1 far, 2 hood
  elapsed = 0;
  offRoadTime = 0;
  private camPos = new THREE.Vector3();
  private camTarget = new THREE.Vector3();
  /** After impact: show crash FX, then open result panel */
  private crashDelay = 0;
  private pendingResult: { phase: Phase; title: string; detail: string } | null = null;
  private crashShake = 0;
  private lastOnRoad = true;
  /** Countdown while the car sits in the bay with the success banner */
  private parkedTimer = 0;
  private insideDestS = 0;

  // DOM
  private el = {
    menu: document.getElementById("menu")!,
    hud: document.getElementById("hud")!,
    result: document.getElementById("result")!,
    resultTitle: document.getElementById("result-title")!,
    resultDetail: document.getElementById("result-detail")!,
    speed: document.getElementById("speed")!,
    timer: document.getElementById("timer")!,
    distance: document.getElementById("distance")!,
    nav: document.getElementById("nav-arrow")!,
    mission: document.getElementById("mission-text")!,
    placeChip: document.getElementById("place-chip"),
    parkedTitle: document.getElementById("parked-title"),
    wheel: document.getElementById("steering-wheel")!,
    status: document.getElementById("status-msg")!,
    lightStatus: document.getElementById("light-status")!,
    gearBox: document.getElementById("gear-box")!,
    blinkLeft: document.getElementById("blink-left")!,
    blinkRight: document.getElementById("blink-right")!,
    gearReadout: document.getElementById("gear-readout")!,
    gearKnob: document.getElementById("gear-knob"),
    gearTag: document.getElementById("gear-console-tag"),
    parkedBanner: document.getElementById("parked-banner")!,
    parkedDetail: document.getElementById("parked-detail")!,
    placesList: document.getElementById("places-list"),
    crashFlash: document.getElementById("crash-flash")!,
    crashBanner: document.getElementById("crash-banner")!,
    btnManual: document.getElementById("btn-mode-manual"),
    btnAuto: document.getElementById("btn-mode-auto"),
    autoStatus: document.getElementById("auto-status"),
  };

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x87c5e8);
    this.scene.fog = new THREE.Fog(0xa8d4ea, 90, 320);

    // Lighting — bright daytime
    const hemi = new THREE.HemisphereLight(0xdceeff, 0x5a7a48, 0.7);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xfff1d6, 1.55);
    sun.position.set(70, 100, 45);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 10;
    sun.shadow.camera.far = 280;
    sun.shadow.camera.left = -130;
    sun.shadow.camera.right = 130;
    sun.shadow.camera.top = 130;
    sun.shadow.camera.bottom = -130;
    sun.shadow.bias = -0.0002;
    this.scene.add(sun);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.32));
    const fill = new THREE.DirectionalLight(0xb0c4de, 0.35);
    fill.position.set(-40, 30, -20);
    this.scene.add(fill);

    this.world = new CityWorld();
    this.scene.add(this.world.group);

    this.player = new Vehicle(PLAYER_COLOR, true, "sedan");
    this.scene.add(this.player.mesh);

    this.traffic = new TrafficSystem(this.world, this.scene);
    this.pedestrians = new PedestrianSystem(this.scene, PED_COUNT, this.world);

    const mapCanvas = document.getElementById("minimap") as HTMLCanvasElement | null;
    if (mapCanvas) this.minimap = new MiniMap(mapCanvas);

    this.resetPlayer();
    this.bindUi();
    this.controls.bindHud();

    window.addEventListener("resize", () => this.onResize());
    this.onResize();

    // Render city on the menu immediately
    this.clock.start();
    this.loop();
  }

  private bindUi() {
    document.getElementById("btn-start")!.addEventListener("click", () => this.start());
    document.getElementById("btn-restart")!.addEventListener("click", () => this.start());
    document.getElementById("btn-menu")!.addEventListener("click", () => this.toMenu());
    document.getElementById("btn-camera")!.addEventListener("click", () => {
      this.cameraMode = (this.cameraMode + 1) % 3;
    });

    this.el.gearBox.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        const g = (btn as HTMLElement).dataset.gear as Gear;
        this.setGear(g);
      });
    });

    this.el.btnManual?.addEventListener("click", () => this.setDriveMode("manual"));
    this.el.btnAuto?.addEventListener("click", () => this.setDriveMode("auto"));
    document.getElementById("btn-jev-trust")?.addEventListener("click", () => {
      const mode = this.autoDriver.cycleTrust();
      this.syncTrustButton();
      this.el.status.textContent = `Jev trust → ${mode}`;
      // Keep Automation server default in sync (best-effort)
      void fetch("http://127.0.0.1:8787/drive/trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ trust: mode }),
      }).catch(() => undefined);
    });
  }

  private syncTrustButton() {
    const btn = document.getElementById("btn-jev-trust");
    if (!btn) return;
    const label = this.autoDriver.trustLabel();
    btn.textContent = label;
    btn.classList.remove("follow", "strict", "soft", "planner");
    const t = this.autoDriver.trust;
    if (t === "follow_jev") btn.classList.add("follow");
    else if (t === "strict_confidence") btn.classList.add("strict");
    else if (t === "soft_confidence") btn.classList.add("soft");
    else btn.classList.add("planner");
  }

  private jevPanelTimer = 0;
  private jevPanelKey = "";

  /** Jev decision log: what the brain answered and what the car did with it */
  private renderJevPanel(auto: boolean, dt: number) {
    const panel = document.getElementById("jev-panel");
    if (!panel) return;
    panel.classList.toggle("hidden", !auto);
    if (!auto) return;
    this.jevPanelTimer -= dt;
    if (this.jevPanelTimer > 0) return;
    this.jevPanelTimer = 0.2;

    const link = document.getElementById("jev-link");
    const header = this.autoDriver.jevHeader();
    if (link) {
      link.textContent = header;
      link.classList.toggle("offline", header.startsWith("OFFLINE"));
    }
    this.syncTrustButton();
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
    const now = this.autoDriver.liveFollow();
    const nowEl = document.getElementById("jev-now");
    if (nowEl) {
      const wait = now.wait ? ` · ${now.wait}` : "";
      nowEl.innerHTML =
        `<span class="tag">CAR NOW</span>` +
        `<b class="turn">${esc(now.turn)}</b>` +
        `<span>G${esc(now.gear)}</span>` +
        `<span>${esc(now.pace)}</span>` +
        `<span class="src">${esc(now.stage)} · ${esc(now.source)}${esc(wait)}</span>`;
    }
    const score = document.getElementById("jev-score");
    if (score) {
      score.innerHTML = this.autoDriver
        .jevScore()
        .map((c) => `<div class="${c.cls ?? ""}"><span>${esc(c.label)}</span><b>${esc(c.value)}</b></div>`)
        .join("");
    }
    const list = document.getElementById("jev-log");
    if (!list) return;
    const log = this.autoDriver.log;
    const key = `${now.turn}:${now.gear}:${now.pace}:${now.source}:${log.length}:${log[0]?.seq ?? 0}:${log[0]?.repeats ?? 1}:${log[0]?.jev_turn ?? ""}`;
    if (key === this.jevPanelKey) return;
    this.jevPanelKey = key;
    const badge = (v: string) => `<span class="jev-badge ${v}">${v === "clean" ? "✓" : v === "fixed" ? "~" : v === "fallback" ? "F" : "✕"}</span>`;
    list.innerHTML = log
      .slice(0, 10)
      .map((e) => {
        const jevT = (e.jev_turn || "-").toUpperCase();
        const carT = (e.car_turn || "-").toUpperCase();
        const mismatch = jevT !== "-" && carT !== "-" && jevT !== carT;
        const cls = [e.verdict === "error" ? "err" : e.verdict === "fallback" ? "fallback" : "", mismatch ? "mismatch" : ""]
          .filter(Boolean)
          .join(" ");
        const t = `${Math.floor(e.t / 60)}:${String(Math.floor(e.t % 60)).padStart(2, "0")}`;
        const seq = `<span class="jev-seq">#${e.seq}${e.repeats && e.repeats > 1 ? ` ×${e.repeats}` : ""}</span>`;
        const lat = e.latency_ms ? `${Math.round(e.latency_ms)} ms` : "";
        const src = e.source.replace("jev:", "").replace("local_fallback", "fallback");
        return (
          `<li class="${cls}"><span class="jev-t">${t}</span><span class="jev-main">${badge(e.verdict)}` +
          `<span class="jev-ask">ASK ${esc(e.asked)} → <span class="turn">${esc(jevT)}</span> · G${esc(e.jev_gear)} · ${esc(e.jev_pace)}</span>` +
          `<span class="jev-car">CAR <span class="turn">${esc(carT)}</span> · G${esc(e.car_gear)} · ${esc(e.car_pace)} · ${esc(e.car_source)}</span>` +
          `<span class="jev-sub">${esc(src)} ${lat}${seq}${e.applied ? " · " + esc(e.applied) : ""}${e.note ? " · " + esc(e.note) : ""}</span></span></li>`
        );
      })
      .join("");
  }

  private setDriveMode(mode: "manual" | "auto") {
    this.autoDriver.setMode(mode);
    this.syncTrustButton();
    this.el.btnManual?.classList.toggle("active", mode === "manual");
    this.el.btnAuto?.classList.toggle("active", mode === "auto");
    if (this.el.gearTag) {
      this.el.gearTag.textContent = mode === "auto" ? "AUTO · JEV SELECTS" : "MANUAL · Q/E · 1–5";
      this.el.gearTag.classList.toggle("auto", mode === "auto");
    }
    if (this.el.autoStatus) {
      this.el.autoStatus.textContent =
        mode === "auto" ? "AUTO · start Automation server on :8787" : "";
    }
  }

  private resetPlayer() {
    const { xs, zs } = getCityAxes();
    // Start on a mid-ish NS road so early drive can hit a long boulevard
    const roadX = xs[Math.min(2, xs.length - 1)];
    const along = zs[0] + (zs[1] - zs[0]) * 0.35;
    const pose = poseOnRoad("z", roadX, along, 1, 1);
    this.player.crashed = false;
    this.player.fuel = 100;
    this.player.gear = "1";
    this.player.speed = 0;
    this.player.steer = 0;
    this.player.setPose(pose.x, pose.z, pose.yaw);
    this.setGear("1");
  }

  start() {
    void this.carAudio.unlock();
    this.carAudio.resetCrashFlag();
    this.world.rollMission();
    this.resetPlayer();
    this.traffic.resetAround(this.player);
    this.pedestrians.reset();
    this.elapsed = 0;
    this.offRoadTime = 0;
    this.pendingResult = null;
    this.crashDelay = 0;
    this.hideCrashFx();
    this.setDriveMode("manual");
    if (this.el.autoStatus) this.el.autoStatus.textContent = "";
    this.phase = "playing";
    this.parkedTimer = 0;
    this.insideDestS = 0;
    this.el.parkedBanner.classList.add("hidden");
    this.el.menu.classList.add("hidden");
    this.el.result.classList.add("hidden");
    this.el.hud.classList.remove("hidden");
    const place = this.world.destinationPlace?.name ?? "the city area";
    this.el.mission.textContent = `Drive to ${place}`;
    if (this.el.placeChip) {
      this.el.placeChip.textContent = this.world.destinationPlace?.short ?? "MISSION";
      this.el.placeChip.classList.remove("near", "here");
    }
    this.el.status.textContent = "";
    this.renderPlacesPanel();
    document.body.classList.add("playing");
  }

  toMenu() {
    this.phase = "menu";
    this.carAudio.silence();
    this.el.parkedBanner.classList.add("hidden");
    this.el.hud.classList.add("hidden");
    this.el.result.classList.add("hidden");
    this.el.menu.classList.remove("hidden");
    document.body.classList.remove("playing");
  }

  private setGear(g: Gear) {
    this.player.gear = g;
    this.el.gearBox.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", (btn as HTMLElement).dataset.gear === g);
    });
    if (this.el.gearReadout) this.el.gearReadout.textContent = g;
    const [col, row] = GEAR_POS[g];
    this.el.gearKnob?.style.setProperty("--col", String(col));
    this.el.gearKnob?.style.setProperty("--row", String(row));
  }

  private end(phase: Phase, title: string, detail: string) {
    this.phase = phase;
    this.carAudio.silence();
    this.el.resultTitle.textContent = title;
    this.el.resultDetail.textContent = detail;
    this.el.result.classList.remove("hidden");
    document.body.classList.remove("playing");
  }

  private onResize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private loop = () => {
    requestAnimationFrame(this.loop);
    const dt = Math.min(this.clock.getDelta(), 0.05);

    if (this.phase === "playing") {
      this.updatePlay(dt);
    } else if (this.phase === "parked") {
      this.updateParked(dt);
    } else {
      this.pedestrians.update(dt, [this.player, ...this.traffic.cars.map((c) => c.vehicle)]);
      this.world.updateLights(dt);
      this.updateCamera(dt);
    }

    this.renderer.render(this.scene, this.camera);
  };

  private updatePlay(dt: number) {
    this.elapsed += dt;

    // Crash impact playing — show collision, then popup
    if (this.pendingResult) {
      this.crashDelay -= dt;
      this.crashShake = Math.max(0, this.crashShake - dt);
      this.player.update(dt, { throttle: 0, brake: 1, steer: 0, handbrake: true });
      this.carAudio.update(dt, {
        speedMps: this.player.speed,
        speedKmh: this.player.speedKmh(),
        throttle: 0,
        brake: 1,
        handbrake: true,
        gear: this.player.gear,
        crashed: true,
        playing: true,
      });
      this.traffic.update(dt, this.player, this.pedestrians);
      this.pedestrians.update(dt, [this.player, ...this.traffic.cars.map((c) => c.vehicle)]);
      this.minimap?.draw(this.player, this.world);
      this.updateCamera(dt);
      // Camera shake
      if (this.crashShake > 0) {
        this.camera.position.x += (Math.random() - 0.5) * 0.35;
        this.camera.position.y += (Math.random() - 0.5) * 0.2;
      }
      if (this.crashDelay <= 0) {
        const r = this.pendingResult;
        this.pendingResult = null;
        this.hideCrashFx();
        this.end(r.phase, r.title, r.detail);
      }
      return;
    }

    if (this.controls.consumeCameraToggle()) {
      this.cameraMode = (this.cameraMode + 1) % 3;
    }

    const auto = this.autoDriver.mode === "auto";
    if (!auto) {
      const g = this.controls.consumeGearKeys(this.player.gear);
      if (g) this.setGear(g);
    } else {
      const ag = this.autoDriver.consumeGear();
      if (ag) this.setGear(ag);
    }

    // Sense world for Jev / local fallback (also used before physics step)
    if (auto) {
      const sensed = buildDriveState(
        this.player,
        this.world,
        this.traffic,
        this.pedestrians,
        this.lastOnRoad,
        this.autoDriver.targetLane,
      );
      this.autoDriver.update(dt, sensed.state, sensed.ctx);
      this.player.blinkOverride = this.autoDriver.blinker;
    } else {
      this.player.blinkOverride = null;
    }

    // Horn: auto driver decides (stalled lead on green) or manual H key
    const horn = auto ? this.autoDriver.consumeHorn() : this.controls.consumeHorn();
    if (horn) {
      this.carAudio.horn(auto ? "double" : "long");
      this.traffic.honk(this.player);
    }

    const input = auto ? this.autoDriver.sampleInput() : this.controls.sample();
    this.player.update(dt, input);
    this.traffic.update(dt, this.player, this.pedestrians);
    this.pedestrians.update(dt, [this.player, ...this.traffic.cars.map((c) => c.vehicle)]);

    this.carAudio.update(dt, {
      speedMps: this.player.speed,
      speedKmh: this.player.speedKmh(),
      throttle: input.throttle,
      brake: input.brake,
      handbrake: input.handbrake,
      gear: this.player.gear,
      crashed: this.player.crashed,
      playing: true,
    });

    const offRoad = this.traffic.softRoadConstraint(this.player);
    this.lastOnRoad = !offRoad;
    // Indian keep-left: if player is clearly on a N/S road going north/south but
    // sitting on the oncoming half, nudge them back to the left of yellow
    const inBox = insideJunctionBox(this.player.position.x, this.player.position.z);
    if (!inBox && !(auto && this.autoDriver.inTurnOrRecover())) this.enforcePlayerKeepLeft(dt);
    if (offRoad) {
      this.offRoadTime += dt;
      this.el.status.textContent = "Off road — return to the street!";
    } else if (this.offRoadTime > 0) {
      this.offRoadTime = Math.max(0, this.offRoadTime - dt);
      if (!auto) this.el.status.textContent = "";
    }

    if (auto && this.el.autoStatus) {
      this.el.autoStatus.textContent = this.autoDriver.statusLine();
    }
    if (auto) {
      const line = this.autoDriver.statusLine();
      if (line && !this.el.status.textContent.includes("Off road")) {
        this.el.status.textContent = line;
      }
    }
    this.renderJevPanel(auto, dt);

    // Building collision
    if (this.world.hitBuilding(this.player.aabb())) {
      this.beginCrash("crashed", "CRASH!", "You hit a building. Drive carefully.");
      return;
    }

    // Traffic collision
    if (this.traffic.collidePlayer(this.player)) {
      this.beginCrash("crashed", "CRASH!", "Collision with another vehicle.");
      return;
    }

    // Pedestrian collision
    if (this.pedestrians.collidePlayer(this.player)) {
      this.beginCrash("crashed", "PEDESTRIAN HIT!", "You hit a pedestrian. Game over.");
      return;
    }

    // Destination: entering the named block is enough (no tiny bay)
    const here = this.world.inDestination(this.player.position.x, this.player.position.z);
    if (here) {
      this.insideDestS += dt;
      if (this.insideDestS > 0.45) {
        this.beginParked();
        return;
      }
    } else {
      this.insideDestS = 0;
    }

    const dist = this.world.distToDestination(this.player.position.x, this.player.position.z);

    // Traffic light HUD — same axis resolver as driveSense (corridor, not yaw flip)
    const near = this.world.nearestLight(this.player.position.x, this.player.position.z, this.player.yaw);
    if (near && near.dist < 40) {
      const { approaching, arm } = approachSignalAxis(this.player, near);
      const sig = this.world.signalForApproach(arm, near.light);
      const secs = Math.max(0, Math.ceil(this.world.signalSecondsForApproach(arm, near.light)));
      this.el.lightStatus.textContent = `${sig} ${secs}s`;
      this.el.lightStatus.className = `light-status signal-${sig.toLowerCase()}`;
      const stopLine = STOP_LINE_SETBACK;
      // Clear stale red-run message when light is legal again
      if (sig === "GREEN" || sig === "YELLOW") {
        if (this.el.status.textContent.includes("red light")) {
          this.el.status.textContent = "";
        }
      }
      // Only punish once when actually crossing stop line on RED while moving forward fast
      if (
        approaching &&
        sig === "RED" &&
        this.player.speed > 0.5 &&
        near.dist < stopLine - 1 &&
        near.dist > ROAD_WIDTH * 0.35 &&
        this.player.speedKmh() > 18
      ) {
        this.el.status.textContent = "⚠ Ran a red light";
      }
    } else {
      this.el.lightStatus.textContent = "—";
      this.el.lightStatus.className = "light-status";
    }

    this.updateHud(dist);
    this.minimap?.draw(this.player, this.world);

    // Pulse destination beacon so it's always noticeable
    const beacon = this.world.destinationMarker.userData.beacon as THREE.Mesh | undefined;
    if (beacon) {
      const mat = beacon.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.8 + Math.sin(this.elapsed * 4) * 0.5;
    }

    this.updateCamera(dt);
  }

  /** Pull player onto the keep-left half when driving along a city road */
  private enforcePlayerKeepLeft(dt: number) {
    const p = this.player;
    const yaw = p.yaw;
    // Mostly north/south
    if (Math.abs(Math.sin(yaw)) < 0.5) {
      const goingNorth = Math.cos(yaw) > 0;
      let bestRoad = this.world.roads[0];
      let bestD = Infinity;
      for (const r of this.world.roads) {
        if (r.axis !== "z") continue;
        const d = Math.abs(p.position.x - r.pos);
        if (d < bestD) {
          bestD = d;
          bestRoad = r;
        }
      }
      if (bestD < ROAD_WIDTH / 2 + 1) {
        const dir = (goingNorth ? 1 : -1) as 1 | -1;
        // Screen keep-left: northbound on +X half; southbound on −X half
        const onWrongSide = goingNorth
          ? p.position.x < bestRoad.pos - 0.15
          : p.position.x > bestRoad.pos + 0.15;
        if (onWrongSide) {
          const target = poseOnRoad("z", bestRoad.pos, p.position.z, dir, 1).x;
          const deepWrong = goingNorth
            ? p.position.x < bestRoad.pos - LANE_WIDTH * 0.35
            : p.position.x > bestRoad.pos + LANE_WIDTH * 0.35;
          p.position.x = deepWrong
            ? target
            : THREE.MathUtils.damp(p.position.x, target, 10, dt);
          p.syncMesh();
          if (!this.el.status.textContent) {
            this.el.status.textContent = "Keep LEFT of the yellow line (India)";
          }
        }
      }
    } else if (Math.abs(Math.cos(yaw)) < 0.5) {
      // Mostly east/west
      const goingEast = Math.sin(yaw) > 0;
      let bestRoad = this.world.roads[0];
      let bestD = Infinity;
      for (const r of this.world.roads) {
        if (r.axis !== "x") continue;
        const d = Math.abs(p.position.z - r.pos);
        if (d < bestD) {
          bestD = d;
          bestRoad = r;
        }
      }
      if (bestD < ROAD_WIDTH / 2 + 1) {
        const dir = (goingEast ? 1 : -1) as 1 | -1;
        // Screen keep-left: eastbound on −Z half; westbound on +Z half
        const onWrongSide = goingEast
          ? p.position.z > bestRoad.pos + 0.15
          : p.position.z < bestRoad.pos - 0.15;
        if (onWrongSide) {
          const target = poseOnRoad("x", bestRoad.pos, p.position.x, dir, 1).z;
          const deepWrong = goingEast
            ? p.position.z > bestRoad.pos + LANE_WIDTH * 0.35
            : p.position.z < bestRoad.pos - LANE_WIDTH * 0.35;
          p.position.z = deepWrong
            ? target
            : THREE.MathUtils.damp(p.position.z, target, 10, dt);
          p.syncMesh();
          if (!this.el.status.textContent) {
            this.el.status.textContent = "Keep LEFT of the yellow line (India)";
          }
        }
      }
    }
  }

  /** Player entered the named destination block */
  private beginParked() {
    this.phase = "parked";
    this.parkedTimer = PARKED_HOLD_S;
    this.player.speed = 0;
    this.player.signalBrake = true;
    this.setGear("P");
    const auto = this.autoDriver.mode === "auto";
    const place = this.world.destinationPlace?.name ?? "the city area";
    if (this.el.parkedTitle) this.el.parkedTitle.textContent = "ARRIVED";
    this.el.parkedDetail.textContent = auto
      ? `Jev reached ${place} · time ${formatTime(this.elapsed)}`
      : `You reached ${place} · time ${formatTime(this.elapsed)}`;
    this.el.parkedBanner.classList.remove("hidden");
    this.el.status.textContent = `✔ Arrived · ${place}`;
    this.el.mission.textContent = `Arrived at ${place}`;
    if (this.el.placeChip) {
      this.el.placeChip.textContent = "HERE";
      this.el.placeChip.classList.add("here");
    }
    this.carAudio.update(0.016, {
      speedMps: 0,
      speedKmh: 0,
      throttle: 0,
      brake: 1,
      handbrake: true,
      gear: "P",
      crashed: false,
      playing: true,
    });
  }

  private updateParked(dt: number) {
    this.parkedTimer -= dt;
    // Car sits still; hazards on like a real parked EV, world keeps living
    this.player.update(dt, { throttle: 0, brake: 1, steer: 0, handbrake: true });
    this.player.blinkOverride = Math.floor(this.elapsed * 2) % 2 === 0 ? "left" : "right";
    this.elapsed += dt;
    this.traffic.update(dt, this.player, this.pedestrians);
    this.pedestrians.update(dt, [this.player, ...this.traffic.cars.map((c) => c.vehicle)]);
    this.minimap?.draw(this.player, this.world);
    this.el.speed.textContent = "0";
    this.updateCamera(dt);
    const beacon = this.world.destinationMarker.userData.beacon as THREE.Mesh | undefined;
    if (beacon) {
      const mat = beacon.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 1.2 + Math.sin(this.elapsed * 8) * 0.6;
    }
    if (this.parkedTimer <= 0) {
      this.el.parkedBanner.classList.add("hidden");
      this.player.blinkOverride = null;
      this.end("won", "ARRIVED!", `Reached ${this.world.destinationPlace?.name ?? "the area"}. Drive time ${formatTime(this.elapsed - PARKED_HOLD_S)}`);
    }
  }

  /** Show collision impact first; result popup after a short delay */
  private beginCrash(phase: Phase, title: string, detail: string) {
    if (this.pendingResult) return;
    this.player.crashed = true;
    this.player.speed *= 0.25;
    this.pendingResult = { phase, title, detail };
    this.crashDelay = 1.85;
    this.crashShake = 0.9;
    this.el.status.textContent = "💥 COLLISION!";
    this.el.crashFlash.classList.remove("hidden");
    this.el.crashBanner.classList.remove("hidden");
    this.el.crashBanner.textContent =
      title === "PEDESTRIAN HIT!" ? "💥 PEDESTRIAN HIT!" : "💥 COLLISION!";
  }

  private hideCrashFx() {
    this.el.crashFlash.classList.add("hidden");
    this.el.crashBanner.classList.add("hidden");
    this.crashShake = 0;
  }

  private updateHud(dist: number) {
    this.el.speed.textContent = String(this.player.speedKmh());
    this.el.timer.textContent = formatTime(this.elapsed);
    this.el.distance.textContent = dist < 0.5 ? "HERE" : `${Math.round(dist)} m`;
    const chip = this.el.placeChip;
    if (chip && this.world.destinationPlace) {
      chip.classList.toggle("near", dist < 40 && dist >= 0.5);
      chip.classList.toggle("here", dist < 0.5);
      chip.textContent = dist < 0.5 ? "HERE" : this.world.destinationPlace.short;
    }

    // Nav arrow: screen-space bearing (chase cam mirrors geographic left/right)
    const to = this.world.destination.clone().sub(this.player.position);
    const angle = this.player.yaw - Math.atan2(to.x, to.z);
    this.el.nav.style.transform = `rotate(${(angle * 180) / Math.PI}deg)`;

    // Turn signals: auto uses auto steer; manual uses keys/wheel
    if (this.autoDriver.mode === "auto") {
      this.el.blinkLeft.classList.toggle("on", this.autoDriver.blinker === "left");
      this.el.blinkRight.classList.toggle("on", this.autoDriver.blinker === "right");
    } else {
      const blinkSteer = this.controls.steer;
      this.el.blinkLeft.classList.toggle("on", blinkSteer > 0.2);
      this.el.blinkRight.classList.toggle("on", blinkSteer < -0.2);
    }

    // Steering wheel visual (CSS: negative = counterclockwise = left)
    const wheelSteer =
      this.autoDriver.mode === "auto" ? this.autoDriver.sampleInput().steer : this.player.steer / 0.62;
    const deg = -Math.max(-1, Math.min(1, wheelSteer)) * 90;
    this.el.wheel.style.transform = `rotate(${deg}deg)`;

    // Pedal pressed state
    const ped =
      this.autoDriver.mode === "auto" ? this.autoDriver.sampleInput() : this.controls;
    document.getElementById("pedal-gas")!.classList.toggle("pressed", ped.throttle > 0.2);
    document
      .getElementById("pedal-brake")!
      .classList.toggle("pressed", ped.brake > 0.2 || ("handbrake" in ped && ped.handbrake));
    this.renderPlacesPanel();
  }

  private renderPlacesPanel() {
    const ul = this.el.placesList;
    if (!ul) return;
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const dest = this.world.destinationPlace;
    const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c] ?? c);
    const rows = [...this.world.places].sort((a, b) => {
      const am = dest && a.bx === dest.bx && a.bz === dest.bz ? 0 : 1;
      const bm = dest && b.bx === dest.bx && b.bz === dest.bz ? 0 : 1;
      if (am !== bm) return am - bm;
      return distToPlace(a, px, pz) - distToPlace(b, px, pz);
    });
    ul.innerHTML = rows
      .map((p) => {
        const d = distToPlace(p, px, pz);
        const mission = !!(dest && p.bx === dest.bx && p.bz === dest.bz);
        const here = d < 0.5;
        const col = `#${p.accent.toString(16).padStart(6, "0")}`;
        const cls = [mission ? "mission" : "", here ? "here" : ""].filter(Boolean).join(" ");
        return `<li class="${cls}"><span class="dot" style="background:${col}"></span><span class="nm">${esc(p.name)}</span><span class="m">${here ? "HERE" : `${Math.round(d)} m`}</span></li>`;
      })
      .join("");
  }

  private updateCamera(dt: number) {
    const p = this.player.position;
    const yaw = this.player.yaw;
    const back = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const up = new THREE.Vector3(0, 1, 0);

    let desired = new THREE.Vector3();
    let look = new THREE.Vector3();

    if (this.phase === "menu") {
      const t = performance.now() * 0.00015;
      desired.set(Math.cos(t) * 55, 28, Math.sin(t) * 55);
      look.set(0, 0, 0);
    } else if (this.cameraMode === 0) {
      // Medium chase — classic Dr. Driving
      desired.copy(p).addScaledVector(back, 9.5).addScaledVector(up, 4.2);
      look.copy(p).addScaledVector(back, -6).addScaledVector(up, 1.2);
    } else if (this.cameraMode === 1) {
      desired.copy(p).addScaledVector(back, 16).addScaledVector(up, 8);
      look.copy(p).addScaledVector(back, -4).addScaledVector(up, 1);
    } else {
      // Hood / cabin-ish
      const fwd = this.player.forward;
      desired.copy(p).addScaledVector(fwd, 0.6).addScaledVector(up, 1.35);
      look.copy(p).addScaledVector(fwd, 12).addScaledVector(up, 1.1);
    }

    const lerp = this.phase === "menu" ? 2 : 6;
    this.camPos.lerp(desired, 1 - Math.exp(-lerp * dt));
    this.camTarget.lerp(look, 1 - Math.exp(-lerp * dt));
    this.camera.position.copy(this.camPos);
    this.camera.lookAt(this.camTarget);

    // Sun follows player lightly for shadows
  }
}

function formatTime(s: number) {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}
