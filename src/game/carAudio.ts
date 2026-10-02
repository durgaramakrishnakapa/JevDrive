/**
 * Procedural real-time car audio via Web Audio API.
 * Engine pitch/load follows speed + gear + throttle; brake/road layers mix live.
 */

export interface CarAudioSample {
  speedMps: number;
  speedKmh: number;
  throttle: number;
  brake: number;
  handbrake: boolean;
  gear: string;
  crashed: boolean;
  playing: boolean;
}

function clamp(v: number, a: number, b: number) {
  return Math.max(a, Math.min(b, v));
}

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/** Gear index for RPM curve (1–5); R/N/P treated specially */
function gearRatio(gear: string): number {
  switch (gear) {
    case "1":
      return 3.4;
    case "2":
      return 2.2;
    case "3":
      return 1.55;
    case "4":
      return 1.15;
    case "5":
      return 0.9;
    case "R":
      return 2.8;
    default:
      return 0;
  }
}

export class CarAudio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private engineGain: GainNode | null = null;
  private roadGain: GainNode | null = null;
  private brakeGain: GainNode | null = null;
  private skidGain: GainNode | null = null;

  private engineOscA: OscillatorNode | null = null;
  private engineOscB: OscillatorNode | null = null;
  private engineOscC: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineLfo: OscillatorNode | null = null;
  private engineLfoGain: GainNode | null = null;

  private roadFilter: BiquadFilterNode | null = null;
  private brakeFilter: BiquadFilterNode | null = null;
  private skidFilter: BiquadFilterNode | null = null;

  private noiseBuf: AudioBuffer | null = null;
  private started = false;
  private lastGear = "";
  private idleRpm = 850;
  private smoothedRpm = 850;
  private smoothedThrottle = 0;

  /** Must be called from a user gesture (START button). */
  async unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.buildGraph();
    }
    if (this.ctx.state === "suspended") {
      await this.ctx.resume();
    }
    if (!this.started) {
      this.startSources();
      this.started = true;
    }
  }

  private buildGraph() {
    const ctx = this.ctx!;
    this.master = ctx.createGain();
    this.master.gain.value = 0.55;
    this.master.connect(ctx.destination);

    this.engineGain = ctx.createGain();
    this.engineGain.gain.value = 0;
    this.roadGain = ctx.createGain();
    this.roadGain.gain.value = 0;
    this.brakeGain = ctx.createGain();
    this.brakeGain.gain.value = 0;
    this.skidGain = ctx.createGain();
    this.skidGain.gain.value = 0;

    this.engineGain.connect(this.master);
    this.roadGain.connect(this.master);
    this.brakeGain.connect(this.master);
    this.skidGain.connect(this.master);

    // Shared noise buffer
    this.noiseBuf = this.makeNoiseBuffer(ctx, 2);

    // Engine: three detuned saws through a lowpass + subtle LFO
    this.engineFilter = ctx.createBiquadFilter();
    this.engineFilter.type = "lowpass";
    this.engineFilter.frequency.value = 420;
    this.engineFilter.Q.value = 1.1;
    this.engineFilter.connect(this.engineGain);

    this.engineLfoGain = ctx.createGain();
    this.engineLfoGain.gain.value = 8;
    this.engineLfo = ctx.createOscillator();
    this.engineLfo.type = "sine";
    this.engineLfo.frequency.value = 6;
    this.engineLfo.connect(this.engineLfoGain);
    this.engineLfoGain.connect(this.engineFilter.frequency);

    this.engineOscA = ctx.createOscillator();
    this.engineOscB = ctx.createOscillator();
    this.engineOscC = ctx.createOscillator();
    this.engineOscA.type = "sawtooth";
    this.engineOscB.type = "sawtooth";
    this.engineOscC.type = "square";

    const engMixA = ctx.createGain();
    engMixA.gain.value = 0.35;
    const engMixB = ctx.createGain();
    engMixB.gain.value = 0.28;
    const engMixC = ctx.createGain();
    engMixC.gain.value = 0.12;

    this.engineOscA.connect(engMixA);
    this.engineOscB.connect(engMixB);
    this.engineOscC.connect(engMixC);
    engMixA.connect(this.engineFilter);
    engMixB.connect(this.engineFilter);
    engMixC.connect(this.engineFilter);

    // Engine combustion noise (filtered)
    const engNoise = ctx.createBufferSource();
    engNoise.buffer = this.noiseBuf;
    engNoise.loop = true;
    const engNoiseFilter = ctx.createBiquadFilter();
    engNoiseFilter.type = "bandpass";
    engNoiseFilter.frequency.value = 180;
    engNoiseFilter.Q.value = 0.7;
    const engNoiseGain = ctx.createGain();
    engNoiseGain.gain.value = 0.22;
    engNoise.connect(engNoiseFilter);
    engNoiseFilter.connect(engNoiseGain);
    engNoiseGain.connect(this.engineFilter);
    (this as unknown as { _engNoise: AudioBufferSourceNode })._engNoise = engNoise;

    // Road rumble
    this.roadFilter = ctx.createBiquadFilter();
    this.roadFilter.type = "lowpass";
    this.roadFilter.frequency.value = 280;
    this.roadFilter.Q.value = 0.6;
    const roadSrc = ctx.createBufferSource();
    roadSrc.buffer = this.noiseBuf;
    roadSrc.loop = true;
    roadSrc.connect(this.roadFilter);
    this.roadFilter.connect(this.roadGain);
    (this as unknown as { _roadSrc: AudioBufferSourceNode })._roadSrc = roadSrc;

    // Brake squeal — high bandpass noise
    this.brakeFilter = ctx.createBiquadFilter();
    this.brakeFilter.type = "bandpass";
    this.brakeFilter.frequency.value = 2400;
    this.brakeFilter.Q.value = 6;
    const brakeSrc = ctx.createBufferSource();
    brakeSrc.buffer = this.noiseBuf;
    brakeSrc.loop = true;
    const brakeHi = ctx.createBiquadFilter();
    brakeHi.type = "highpass";
    brakeHi.frequency.value = 900;
    brakeSrc.connect(brakeHi);
    brakeHi.connect(this.brakeFilter);
    this.brakeFilter.connect(this.brakeGain);
    (this as unknown as { _brakeSrc: AudioBufferSourceNode })._brakeSrc = brakeSrc;

    // Tire skid / handbrake scrape
    this.skidFilter = ctx.createBiquadFilter();
    this.skidFilter.type = "bandpass";
    this.skidFilter.frequency.value = 1100;
    this.skidFilter.Q.value = 3.5;
    const skidSrc = ctx.createBufferSource();
    skidSrc.buffer = this.noiseBuf;
    skidSrc.loop = true;
    skidSrc.connect(this.skidFilter);
    this.skidFilter.connect(this.skidGain);
    (this as unknown as { _skidSrc: AudioBufferSourceNode })._skidSrc = skidSrc;
  }

  private startSources() {
    const t = this.ctx!.currentTime;
    this.engineOscA!.start(t);
    this.engineOscB!.start(t);
    this.engineOscC!.start(t);
    this.engineLfo!.start(t);
    (this as unknown as { _engNoise: AudioBufferSourceNode })._engNoise.start(t);
    (this as unknown as { _roadSrc: AudioBufferSourceNode })._roadSrc.start(t);
    (this as unknown as { _brakeSrc: AudioBufferSourceNode })._brakeSrc.start(t);
    (this as unknown as { _skidSrc: AudioBufferSourceNode })._skidSrc.start(t);
  }

  private makeNoiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
    const len = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  update(dt: number, s: CarAudioSample) {
    if (!this.ctx || !this.started || !this.master) return;
    if (this.ctx.state === "suspended") return;

    const now = this.ctx.currentTime;
    const tau = Math.max(0.02, Math.min(0.12, dt * 3));

    if (!s.playing || s.crashed) {
      this.fadeGains(now, 0.08);
      if (s.crashed) this.playCrash();
      return;
    }

    const speed = Math.abs(s.speedMps);
    const kmh = s.speedKmh;
    const thr = clamp(s.throttle, 0, 1);
    const brk = clamp(s.brake, 0, 1);
    this.smoothedThrottle = lerp(this.smoothedThrottle, thr, clamp(dt * 6, 0, 1));

    const ratio = gearRatio(s.gear);
    // RPM from road speed + throttle load (idle when stopped / N/P)
    let targetRpm = this.idleRpm;
    if (ratio > 0) {
      const roadRpm = 700 + speed * ratio * 95;
      const thrBoost = this.smoothedThrottle * (420 + ratio * 80);
      targetRpm = clamp(roadRpm + thrBoost, this.idleRpm, 6200);
      if (kmh < 1.5 && this.smoothedThrottle < 0.05) targetRpm = this.idleRpm;
    } else if (s.gear === "N" || s.gear === "P") {
      targetRpm = this.idleRpm + this.smoothedThrottle * 2800;
    }
    this.smoothedRpm = lerp(this.smoothedRpm, targetRpm, clamp(dt * 5, 0, 1));

    const rpmN = (this.smoothedRpm - this.idleRpm) / (6200 - this.idleRpm);
    // Fundamental ~ RPM / 60 * cylinders/2 feel → map to audible range
    const baseHz = 42 + this.smoothedRpm * 0.045;
    const load = clamp(this.smoothedThrottle * 0.7 + rpmN * 0.45, 0, 1);

    if (this.engineOscA && this.engineOscB && this.engineOscC && this.engineFilter) {
      this.engineOscA.frequency.setTargetAtTime(baseHz, now, tau);
      this.engineOscB.frequency.setTargetAtTime(baseHz * 1.995, now, tau);
      this.engineOscC.frequency.setTargetAtTime(baseHz * 0.5, now, tau);
      this.engineFilter.frequency.setTargetAtTime(280 + load * 900 + rpmN * 400, now, tau);
      if (this.engineLfo) {
        this.engineLfo.frequency.setTargetAtTime(5 + load * 8, now, tau);
      }
    }

    // Engine volume: always a bit of idle when in gear / on
    const idleVol = s.gear === "P" ? 0.04 : 0.12;
    const engVol = clamp(idleVol + rpmN * 0.38 + this.smoothedThrottle * 0.28 + (kmh > 2 ? 0.08 : 0), 0, 0.72);
    this.engineGain!.gain.setTargetAtTime(engVol, now, tau);

    // Road noise scales with speed
    const roadVol = clamp((kmh - 4) / 90, 0, 0.42) * (1 - brk * 0.25);
    this.roadGain!.gain.setTargetAtTime(roadVol, now, tau);
    if (this.roadFilter) {
      this.roadFilter.frequency.setTargetAtTime(180 + kmh * 3.2, now, tau);
    }

    // Brake squeal — stronger at higher speed + harder pedal
    const brakeActive = (brk > 0.12 || s.handbrake) && kmh > 6;
    const brakeVol = brakeActive
      ? clamp((brk * 0.55 + (s.handbrake ? 0.35 : 0)) * clamp((kmh - 5) / 40, 0, 1), 0, 0.38)
      : 0;
    this.brakeGain!.gain.setTargetAtTime(brakeVol, now, 0.04);
    if (this.brakeFilter && brakeActive) {
      this.brakeFilter.frequency.setTargetAtTime(1800 + kmh * 12 + brk * 600, now, tau);
    }

    // Skid: hard handbrake or heavy brake at speed
    const skid =
      s.handbrake && kmh > 12
        ? clamp((kmh - 10) / 50, 0, 0.45)
        : brk > 0.75 && kmh > 28
          ? clamp(((brk - 0.7) * (kmh - 25)) / 40, 0, 0.28)
          : 0;
    this.skidGain!.gain.setTargetAtTime(skid, now, 0.05);
    if (this.skidFilter && skid > 0) {
      this.skidFilter.frequency.setTargetAtTime(900 + kmh * 8, now, tau);
    }

    // Soft master duck when nearly stopped with no throttle
    const master = kmh < 0.5 && this.smoothedThrottle < 0.02 ? 0.35 : 0.55;
    this.master.gain.setTargetAtTime(master, now, 0.15);

    // Gear-change click
    if (s.gear !== this.lastGear && this.lastGear !== "") {
      this.playGearClick();
    }
    this.lastGear = s.gear;
  }

  private fadeGains(now: number, tau: number) {
    this.engineGain?.gain.setTargetAtTime(0, now, tau);
    this.roadGain?.gain.setTargetAtTime(0, now, tau);
    this.brakeGain?.gain.setTargetAtTime(0, now, tau);
    this.skidGain?.gain.setTargetAtTime(0, now, tau);
  }

  private crashPlayed = false;
  private playCrash() {
    if (!this.ctx || !this.master || this.crashPlayed) return;
    this.crashPlayed = true;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, t);
    osc.frequency.exponentialRampToValueAtTime(35, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.55, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
    const noise = ctx.createBufferSource();
    noise.buffer = this.noiseBuf;
    const ng = ctx.createGain();
    ng.gain.setValueAtTime(0.4, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    const nf = ctx.createBiquadFilter();
    nf.type = "lowpass";
    nf.frequency.value = 800;
    osc.connect(g);
    g.connect(this.master);
    noise.connect(nf);
    nf.connect(ng);
    ng.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.45);
    noise.start(t);
    noise.stop(t + 0.3);
  }

  resetCrashFlag() {
    this.crashPlayed = false;
  }

  private playGearClick() {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t = ctx.currentTime;
    const osc = ctx.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(180, t);
    osc.frequency.exponentialRampToValueAtTime(90, t + 0.06);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.12, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g);
    g.connect(this.master);
    osc.start(t);
    osc.stop(t + 0.09);
  }

  private lastHornAt = -10;
  /** Indian city car horn: two detuned reeds, short double "peep-peep" or a longer blast */
  horn(style: "double" | "long" = "double") {
    if (!this.ctx || !this.master) return;
    const ctx = this.ctx;
    const t0 = ctx.currentTime;
    if (t0 - this.lastHornAt < 0.25) return;
    this.lastHornAt = t0;
    const beeps = style === "double" ? [[0, 0.17], [0.24, 0.22]] : [[0, 0.75]];
    for (const [off, len] of beeps) {
      const t = t0 + off;
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.42, t + 0.015);
      g.gain.setValueAtTime(0.42, t + len - 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t + len + 0.03);
      const f = ctx.createBiquadFilter();
      f.type = "bandpass";
      f.frequency.value = 520;
      f.Q.value = 0.9;
      f.connect(g);
      g.connect(this.master);
      for (const [hz, type] of [[415, "square"], [522, "sawtooth"], [830, "triangle"]] as const) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(hz * 0.97, t);
        o.frequency.linearRampToValueAtTime(hz, t + 0.03);
        o.connect(f);
        o.start(t);
        o.stop(t + len + 0.05);
      }
    }
  }

  /** Fade out when leaving play */
  silence() {
    if (!this.ctx || !this.master) return;
    this.fadeGains(this.ctx.currentTime, 0.12);
  }
}
