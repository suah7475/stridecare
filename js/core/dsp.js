/**
 * StrideCare — DSP primitives
 * Pure, DOM-free signal processing used by both the live app and the
 * offline verification harness.
 *
 * All filters operate at a fixed 50 Hz internal rate. Phone sensors deliver
 * irregular timestamps, so raw events are linearly resampled onto a uniform
 * grid before filtering. This keeps every biquad coefficient constant and
 * makes the live detector reproduce the offline result exactly.
 */

export const FS = 50;
export const DT = 1 / FS;

/** RBJ cookbook biquad. */
export class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    this.b0 = b0; this.b1 = b1; this.b2 = b2;
    this.a1 = a1; this.a2 = a2;
    this.x1 = 0; this.x2 = 0; this.y1 = 0; this.y2 = 0;
  }

  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
      - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }

  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }

  static lowpass(f0, fs = FS, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad(
      ((1 - cos) / 2) / a0,
      (1 - cos) / a0,
      ((1 - cos) / 2) / a0,
      (-2 * cos) / a0,
      (1 - alpha) / a0,
    );
  }

  static highpass(f0, fs = FS, q = Math.SQRT1_2) {
    const w0 = (2 * Math.PI * f0) / fs;
    const cos = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * q);
    const a0 = 1 + alpha;
    return new Biquad(
      ((1 + cos) / 2) / a0,
      -((1 + cos) / a0),
      ((1 + cos) / 2) / a0,
      (-2 * cos) / a0,
      (1 - alpha) / a0,
    );
  }
}

/**
 * Tracks the gravity direction from raw accelerometer samples and resolves
 * the body-vertical / horizontal components. A waist- or pocket-mounted
 * phone rotates slowly while walking; a 1.2 s time constant tracks that
 * rotation without absorbing the 1–3 Hz gait signal.
 */
export class VerticalResolver {
  constructor(tau = 1.2) {
    this.tau = tau;
    this.g = [0, 0, 0];
    this.up = [0, 1, 0];
    this.ready = false;
    this.rawCount = 0;
    // Mean absolute value of the raw signal, used as a sanity check that the
    // sensor is reporting m/s^2 rather than g.
    this.magSum = 0;
  }

  reset() {
    this.g = [0, 0, 0];
    this.ready = false;
    this.rawCount = 0;
    this.magSum = 0;
  }

  /** @returns {{vertical:number, lateral:[number,number,number], yaw:number}} */
  push(ax, ay, az, gx, gy, gz, dt = DT) {
    this.rawCount++;
    const mag = Math.hypot(ax, ay, az);
    this.magSum += mag;

    if (!this.ready) {
      // Keep the raw magnitude (≈ 9.81 m/s²) — normalising here would create a
      // large artificial step in the linear-acceleration signal.
      this.g = [ax, ay, az];
      this.ready = true;
      this.updateUp();
      return { vertical: 0, lateral: [0, 0, 0], yaw: 0 };
    }

    const alpha = 1 - Math.exp(-dt / this.tau);
    this.g[0] += (ax - this.g[0]) * alpha;
    this.g[1] += (ay - this.g[1]) * alpha;
    this.g[2] += (az - this.g[2]) * alpha;
    this.updateUp();

    const lx = ax - this.g[0];
    const ly = ay - this.g[1];
    const lz = az - this.g[2];
    const vertical = lx * this.up[0] + ly * this.up[1] + lz * this.up[2];

    // Horizontal part of the linear acceleration.
    const hx = lx - vertical * this.up[0];
    const hy = ly - vertical * this.up[1];
    const hz = lz - vertical * this.up[2];

    // Vertical component of angular velocity ≈ pelvis transverse rotation.
    const yaw = gx * this.up[0] + gy * this.up[1] + gz * this.up[2];

    return { vertical, lateral: [hx, hy, hz], yaw };
  }

  updateUp() {
    const [x, y, z] = this.g;
    const n = Math.hypot(x, y, z) || 1;
    this.up = [x / n, y / n, z / n];
  }

  /** True when the sensor reports plausible accelerometer magnitudes (m/s²). */
  get sensorLooksValid() {
    if (this.rawCount < 10) return true;
    const mean = this.magSum / this.rawCount;
    return mean > 4 && mean < 16;
  }
}

/**
 * Linear-interpolating resampler from irregular motion events to 50 Hz.
 * Events older than the interpolation cursor are discarded; gaps longer than
 * `gapReset` seconds are surfaced so the UI can flag a suspended tab.
 */
export class Resampler {
  constructor(fs = FS, { gapReset = 0.6 } = {}) {
    this.fs = fs;
    this.dt = 1 / fs;
    this.buf = [];
    this.nextT = null;
    this.gapReset = gapReset;
    this.onGap = null;
  }

  push(t, values) {
    this.buf.push({ t, values });
    // Keep a small history for interpolation.
    if (this.buf.length > 512) this.buf.splice(0, this.buf.length - 512);
  }

  /**
   * Emit every grid point up to `now`.
   * @param {number} now seconds
   * @returns {Array<{t:number, values:number[]}>}
   */
  pull(now) {
    const out = [];
    if (this.buf.length < 2) return out;

    if (this.nextT === null) {
      this.nextT = this.buf[0].t;
    }

    // Interpolation cursor.
    let j = 0;
    while (j < this.buf.length - 1 && this.buf[j + 1].t <= this.nextT) j++;

    while (this.nextT <= now && j < this.buf.length - 1) {
      const a = this.buf[j];
      const b = this.buf[j + 1];
      const span = b.t - a.t;

      if (span > this.gapReset) {
        // Sensor stall: restart the grid after the gap instead of inventing
        // samples across it.
        if (this.onGap) this.onGap(span, a.t, b.t);
        this.nextT = b.t;
        j++;
        continue;
      }

      if (this.nextT < a.t) { this.nextT += this.dt; continue; }

      const u = span > 1e-9 ? (this.nextT - a.t) / span : 0;
      const values = a.values.map((v, i) => v + (b.values[i] - v) * u);
      out.push({ t: this.nextT, values });
      this.nextT += this.dt;

      while (j < this.buf.length - 1 && this.buf[j + 1].t < this.nextT) j++;
    }

    if (j > 8) this.buf.splice(0, j - 8);
    return out;
  }
}

/**
 * Streaming feature extractor: raw sensor frame -> band-passed vertical
 * acceleration + vertical angular velocity, sampled at 50 Hz.
 *
 * Band: 0.4–7 Hz. The lower edge removes orientation drift; the upper edge
 * removes shoe-shuffle and motor noise while preserving the heel-strike
 * transient (which carries energy up to ~15 Hz, but whose envelope peak is
 * preserved after 7 Hz smoothing).
 */
export class GaitSignal {
  constructor() {
    this.resolver = new VerticalResolver();
    this.resampler = new Resampler();
    this.hp1 = Biquad.highpass(0.4);
    this.hp2 = Biquad.highpass(0.4);
    this.lp1 = Biquad.lowpass(7.0);
    this.lp2 = Biquad.lowpass(7.0);
    this.lpYaw = Biquad.lowpass(4.0);
    this.t = [];
    this.v = [];
    this.yaw = [];
    this.mag = [];
    this.started = false;
    this.startTime = null;
    this.gaps = 0;
  }

  reset() {
    this.resolver.reset();
    this.resampler = new Resampler();
    this.hp1.reset(); this.hp2.reset(); this.lp1.reset(); this.lp2.reset(); this.lpYaw.reset();
    this.t = []; this.v = []; this.yaw = []; this.mag = [];
    this.started = false;
    this.startTime = null;
    this.gaps = 0;
  }

  /** Feed one raw motion event (t in seconds). */
  pushRaw(t, ax, ay, az, gx, gy, gz) {
    if (!this.startTime) this.startTime = t;
    this.resampler.push(t, [ax, ay, az, gx, gy, gz]);
  }

  /** Resample + filter everything available; returns newly added frames. */
  pump(now) {
    const frames = this.resampler.pull(now);
    const added = [];
    for (const f of frames) {
      const [ax, ay, az, gx, gy, gz] = f.values;
      const r = this.resolver.push(ax, ay, az, gx, gy, gz, DT);
      let v = this.hp1.process(r.vertical);
      v = this.hp2.process(v);
      v = this.lp1.process(v);
      v = this.lp2.process(v);
      const yaw = this.lpYaw.process(r.yaw);
      const hMag = Math.hypot(r.lateral[0], r.lateral[1], r.lateral[2]);

      this.t.push(f.t);
      this.v.push(v);
      this.yaw.push(yaw);
      this.mag.push(hMag);
      added.push({ t: f.t, v, yaw });
    }
    return added;
  }

  /** Drop samples older than `seconds` before now (bounded memory). */
  trim(now, seconds = 15) {
    const cutoff = now - seconds;
    let cut = 0;
    while (cut < this.t.length && this.t[cut] < cutoff) cut++;
    if (cut > 0) {
      this.t.splice(0, cut);
      this.v.splice(0, cut);
      this.yaw.splice(0, cut);
      this.mag.splice(0, cut);
    }
  }

  get sampleCount() { return this.t.length; }
  get duration() { return this.t.length ? this.t[this.t.length - 1] - this.t[0] : 0; }
  get sensorValid() { return this.resolver.sensorLooksValid; }
}

/** Biphasic heel-strike template, zero-mean and unit-norm. */
export function buildHeelStrikeKernel(fs = FS, {
  sigma = 0.055,
  offset = 0.115,
  troughSigma = 0.075,
  troughWeight = 0.58,
} = {}) {
  const K = Math.round(0.34 * fs);
  const k = new Float64Array(K + 1);
  let mean = 0;
  for (let i = 0; i <= K; i++) {
    const u = i / fs;
    k[i] = Math.exp(-0.5 * (u / sigma) ** 2)
      - troughWeight * Math.exp(-0.5 * ((u - offset) / troughSigma) ** 2);
    mean += k[i];
  }
  mean /= K + 1;
  let norm = 0;
  for (let i = 0; i <= K; i++) { k[i] -= mean; norm += k[i] * k[i]; }
  norm = Math.sqrt(norm) || 1;
  for (let i = 0; i <= K; i++) k[i] /= norm;
  return k;
}

/** Small numerical helpers used across core modules. */
export function mean(a) {
  if (!a.length) return 0;
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i];
  return s / a.length;
}

export function std(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  let s = 0;
  for (let i = 0; i < a.length; i++) { const d = a[i] - m; s += d * d; }
  return Math.sqrt(s / (a.length - 1));
}

export function median(a) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const mid = b.length >> 1;
  return b.length % 2 ? b[mid] : (b[mid - 1] + b[mid]) / 2;
}

export function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }

export function quantile(a, q) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const pos = (b.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return b[lo] + (b[hi] - b[lo]) * (pos - lo);
}

/** Normalized autocorrelation of a windowed signal at a given lag. */
export function autocorr(x, lag) {
  const n = x.length;
  if (lag <= 0 || lag >= n) return 0;
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < n - lag; i++) {
    num += x[i] * x[i + lag];
    d1 += x[i] * x[i];
    d2 += x[i + lag] * x[i + lag];
  }
  const den = Math.sqrt(d1 * d2);
  return den > 1e-9 ? num / den : 0;
}
