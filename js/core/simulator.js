/**
 * StrideCare — synthetic gait generator
 *
 * Produces raw phone-frame accelerometer + gyroscope streams with known
 * ground truth. Used for (a) the interactive demo on devices without motion
 * sensors, and (b) automated accuracy checks of the detector across gait
 * patterns that are hard to recruit on demand.
 *
 * The model is intentionally adversarial: it includes paretic-side amplitude
 * loss, step-time asymmetry, shuffle noise, trunk sway, and cane impacts.
 */

import { Biquad } from './dsp.js';

export const PROFILES = {
  healthy: {
    key: 'healthy',
    label: '정상 성인',
    cadence: 110,
    asymmetry: 2,
    amplitude: 2.2,
    pareticRatio: 1,
    shuffle: 0.10,
    cane: false,
  },
  hemiparetic: {
    key: 'hemiparetic',
    label: '편마비 · 중등도',
    cadence: 74,
    asymmetry: 22,
    amplitude: 1.45,
    pareticRatio: 0.52,
    shuffle: 0.45,
    cane: false,
  },
  cane: {
    key: 'cane',
    label: '편마비 · 지팡이',
    cadence: 58,
    asymmetry: 26,
    amplitude: 1.1,
    pareticRatio: 0.55,
    shuffle: 0.5,
    cane: true,
  },
  shuffle: {
    key: 'shuffle',
    label: '저측 · 끌기 보행',
    cadence: 88,
    asymmetry: 11,
    amplitude: 0.78,
    pareticRatio: 0.7,
    shuffle: 1.0,
    cane: false,
  },
  slow: {
    key: 'slow',
    label: '고령 · 서행',
    cadence: 56,
    asymmetry: 14,
    amplitude: 1.0,
    pareticRatio: 0.75,
    shuffle: 0.6,
    cane: false,
  },
};

/** Deterministic PRNG so verification runs are reproducible. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rng) {
  let u = 0, v = 0;
  while (u === 0) u = rng();
  while (v === 0) v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}
function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

/**
 * Build a step schedule with alternating, asymmetric intervals.
 * The paretic side has a longer step time and a smaller impact.
 */
export function buildSchedule(profile, duration, seed = 1, startTime = 0) {
  const rng = mulberry32(seed);
  const p = { ...PROFILES.hemiparetic, ...profile };
  const Tmean = 60 / p.cadence;
  const halfAsym = (p.asymmetry / 100) / 2;
  const times = [];
  const sides = [];   // 0 = paretic, 1 = non-paretic
  let t = startTime + 0.9; // quiet lead-in
  let side = 0;

  while (t < startTime + duration - 0.6) {
    const base = side === 0 ? Tmean * (1 + halfAsym) : Tmean * (1 - halfAsym);
    let interval = base * (1 + gauss(rng) * 0.032);
    if (rng() < 0.012) interval += 0.25 + rng() * 0.3; // hesitation
    times.push(t);
    sides.push(side);
    t += interval;
    side = 1 - side;
  }
  return { times, sides, profile: p };
}

/**
 * @param {object} opts
 * @param {number} opts.duration seconds
 * @param {number} opts.seed
 * @param {object} opts.profile one of PROFILES (or partial override)
 * @param {boolean} opts.includeCane force cane impacts (profile default)
 * @returns raw device-frame streams plus ground truth
 */
export function simulateGait({
  duration = 60,
  seed = 7,
  profile = PROFILES.hemiparetic,
  startTime = 0,
  sampleRate = 50,
} = {}) {
  const p = { ...PROFILES.hemiparetic, ...profile };
  const rng = mulberry32(seed ^ 0x9e3779b9);
  const sched = buildSchedule(p, duration, seed, startTime);
  const n = Math.round(duration * sampleRate);
  const dt = 1 / sampleRate;

  // Device orientation: phone sits slightly tilted on the waist belt.
  const up = normalize([0.16, 0.955, 0.25]);
  let latAxis = normalize(cross([0, 1, 0], up));
  if (latAxis[0] < 0) latAxis = latAxis.map((x) => -x);
  const fwdAxis = normalize(cross(up, latAxis));

  const t = new Float64Array(n);
  const ax = new Float32Array(n), ay = new Float32Array(n), az = new Float32Array(n);
  const gx = new Float32Array(n), gy = new Float32Array(n), gz = new Float32Array(n);

  const strideHz = p.cadence / 120; // one full left-right cycle
  const swayPhase = rng() * Math.PI * 2;

  // Shuffle noise: broadband 3–9 Hz (foot drag, shoe scuff, cane drag).
  const noiseHp = Biquad.highpass(3.0, sampleRate);
  const noiseLp = Biquad.lowpass(9.0, sampleRate);

  // Precompute step pulses analytically (no per-step loop inside the time loop).
  const pulse = (u) => Math.exp(-0.5 * (u / 0.055) ** 2);
  const trough = (u) => Math.exp(-0.5 * (u / 0.075) ** 2);
  const toe = (u) => Math.exp(-0.5 * (u / 0.045) ** 2);

  const steps = sched.times;
  const sides = sched.sides;
  const amps = sides.map((s) => p.amplitude * (s === 0 ? p.pareticRatio : 1));

  for (let i = 0; i < n; i++) {
    const time = startTime + i * dt;
    t[i] = time;

    let vert = 0;
    let yawRate = 0;
    let fore = 0;

    // Sum the two nearest pulses (enough for this cadence range).
    for (let k = 0; k < steps.length; k++) {
      const u = time - steps[k];
      if (u < -0.35) break;
      if (u > 0.35) continue;
      const a = amps[k];
      vert += a * pulse(u) - 0.58 * a * trough(u - 0.115) + 0.22 * a * toe(u + 0.17);
      yawRate += (sides[k] === 0 ? -1 : 1) * 1.35 * Math.exp(-0.5 * (u / 0.085) ** 2);
      fore += a * 0.16 * Math.exp(-0.5 * ((u - 0.05) / 0.13) ** 2);
    }

    // Trunk sway (horizontal) at stride frequency + balance-related slow sway.
    const lat = p.amplitude * 0.34 * Math.sin(2 * Math.PI * strideHz * (time - startTime) + swayPhase)
      + 0.55 * Math.sin(2 * Math.PI * 0.28 * (time - startTime) + 1.1);

    // Shuffle / foot-drag noise (broadband, zero-mean).
    const nz = noiseLp.process(noiseHp.process(gauss(rng)));
    vert += nz * p.shuffle * 0.30;

    // Cane impact: one sharp tap per stride, offset from the paretic strike.
    if (p.cane) {
      for (let k = 0; k < steps.length; k += 2) {
        const u = time - (steps[k] + 0.46 * (60 / p.cadence));
        if (Math.abs(u) < 0.12) {
          vert += 0.72 * p.amplitude * Math.exp(-0.5 * (u / 0.016) ** 2)
            - 0.2 * p.amplitude * Math.exp(-0.5 * ((u - 0.05) / 0.03) ** 2);
        }
      }
    }

    // Sensor noise.
    const nv = gauss(rng) * 0.035;
    const nl = gauss(rng) * 0.03;

    const vAcc = vert + nv;
    ax[i] = 9.81 * up[0] + vAcc * up[0] + lat * latAxis[0] + fore * fwdAxis[0] + nl;
    ay[i] = 9.81 * up[1] + vAcc * up[1] + lat * latAxis[1] + fore * fwdAxis[1] + nl;
    az[i] = 9.81 * up[2] + vAcc * up[2] + lat * latAxis[2] + fore * fwdAxis[2] + nl;

    const gt = gauss(rng) * 0.012;
    gx[i] = yawRate * up[0] + gt;
    gy[i] = yawRate * up[1] + gt;
    gz[i] = yawRate * up[2] + gt;
  }

  return {
    t, ax, ay, az, gx, gy, gz,
    truth: {
      steps: steps.length,
      times: steps,
      sides,
      pareticCount: sides.filter((s) => s === 0).length,
      cadence: p.cadence,
      asymmetry: p.asymmetry,
      profile: p.key,
      duration,
      startTime,
    },
    sampleRate,
  };
}

/**
 * Replays a simulated session at 50 Hz through a callback, mimicking the
 * irregular delivery of real devicemotion events.
 */
export class GaitPlayer {
  constructor(data, { onSample, onEnd, speed = 1 } = {}) {
    this.data = data;
    this.onSample = onSample;
    this.onEnd = onEnd;
    this.speed = speed;
    this.i = 0;
    this.timer = null;
    this.epoch = null;
  }

  start(epoch, fromIndex = 0) {
    this.epoch = epoch ?? performance.now() / 1000;
    this.i = Math.max(0, Math.min(fromIndex, this.data ? this.data.t.length - 1 : 0));
    this.originIndex = this.i;
    this.originT = this.data ? this.data.t[this.originIndex] : 0;
    this.lastTick = performance.now();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 20);
  }

  tick() {
    if (!this.data) return;
    const { t, ax, ay, az, gx, gy, gz } = this.data;
    const now = performance.now() / 1000;
    const elapsed = (now - this.epoch) * this.speed;
    const target = this.originT + elapsed;
    while (this.i < t.length && t[this.i] <= target) {
      this.onSample?.(
        this.epoch + (t[this.i] - this.originT),
        ax[this.i], ay[this.i], az[this.i], gx[this.i], gy[this.i], gz[this.i], t[this.i],
      );
      this.i++;
    }
    if (this.i >= t.length) {
      this.stop();
      this.onEnd?.();
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
