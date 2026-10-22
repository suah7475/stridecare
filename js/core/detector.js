/**
 * StrideCare — step detection core
 *
 * Why a generic pedometer fails in stroke:
 *   • cadence is often 45–90 steps/min (generic devices assume > 100)
 *   • the paretic limb produces a much smaller vertical acceleration
 *   • foot drag / shuffle adds 3–8 Hz noise
 *   • a cane adds an impact once per stride
 *   • trunk sway adds a large horizontal component
 *
 * Pipeline
 *   1. project onto gravity (reject sway)                      [dsp.js]
 *   2. band-pass 0.4–7 Hz                                      [dsp.js]
 *   3. find candidate peaks, score each on four independent
 *      features: peak z-score, pre-rise, post-trough, and
 *      pelvis/thigh rotation (yaw) z-score
 *   4. non-maximum suppression: one step per 260 ms cluster
 *   5. interval filtering with a cadence-adaptive refractory
 *   6. recover missed steps from doubled intervals
 *   7. quality scoring, side assignment and asymmetry
 *
 * The post-trough feature is what separates a heel strike from a toe-off
 * bump: both can have the same peak height in a paretic gait, but only the
 * heel strike is followed by a deep loading trough.
 */

export const DEFAULT_PARAMS = {
  fs: 50,

  // Candidate detection
  statsWindow: 4.0,
  zPeak: 0.45,
  troughMin: 0.50,       // peak-to-trough z-score
  riseMin: 0.35,         // pre-peak rise z-score
  scoreMin: 1.60,
  // Weak-but-rotating rule: a small paretic step may fail the amplitude
  // threshold while still carrying a clear pelvis/thigh rotation signature.
  weakTrough: 0.15,
  weakYawZ: 0.72,
  weakScore: 1.00,
  clusterGap: 0.26,      // seconds; peaks closer than this form one cluster
  absFloor: 0.03,

  // Interval logic
  minInterval: 0.30,
  refractoryFactor: 0.45,
  maxInterval: 2.6,

  // Missed-step recovery
  fillGapLo: 1.55,
  fillGapHi: 2.60,
  fillTroughRatio: 0.25, // relative to median accepted trough z-score
  fillScoreRatio: 0.50,

  // Reporting
  confirmDelay: 0.55,
};

export const SENSITIVITY_PRESETS = {
  high: { zPeak: 0.30, troughMin: 0.35, scoreMin: 1.25, fillTroughRatio: 0.40, label: '민감' },
  standard: {},
  conservative: { zPeak: 0.65, troughMin: 0.70, scoreMin: 1.95, fillTroughRatio: 0.70, label: '보수적' },
};

const EPS = 1e-9;

function medianOf(a) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/**
 * Detect candidate peaks with morphology features.
 * @returns {Array<{t:number,index:number,z:number,riseZ:number,troughZ:number,zY:number,amp:number,score:number}>}
 */
export function findCandidates(t, v, yaw, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const fs = p.fs;
  const n = Math.min(t.length, v.length, yaw ? yaw.length : Infinity);
  if (n < fs) return [];

  const win = Math.round(p.statsWindow * fs);
  const preW = Math.round(0.35 * fs);
  const postW = Math.round(0.28 * fs);

  // Rolling sums via prefix arrays.
  const ps = new Float64Array(n + 1);
  const ps2 = new Float64Array(n + 1);
  const py = new Float64Array(n + 1);
  const py2 = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) {
    ps[i + 1] = ps[i] + v[i];
    ps2[i + 1] = ps2[i] + v[i] * v[i];
    const ay = Math.abs(yaw ? yaw[i] : 0);
    py[i + 1] = py[i] + ay;
    py2[i + 1] = py2[i] + ay * ay;
  }

  let yawUsable = false;
  if (yaw) {
    let s = 0, c = 0;
    for (let i = 0; i < n; i += 5) { s += Math.abs(yaw[i]); c++; }
    yawUsable = c > 0 && s / c > 0.05;
  }

  const out = [];
  for (let i = 4; i < n - postW; i++) {
    const vi = v[i];
    if (vi <= p.absFloor) continue;

    let isPeak = true;
    for (let k = 1; k <= 2; k++) {
      if (v[i - k] > vi || v[i + k] >= vi) { isPeak = false; break; }
    }
    if (!isPeak) continue;

    const lo = Math.max(0, i - win);
    if (i - lo < fs * 0.8) continue;
    const c = i + 1 - lo;

    const mu = (ps[i + 1] - ps[lo]) / c;
    const sd = Math.sqrt(Math.max(0, (ps2[i + 1] - ps2[lo]) / c - mu * mu)) || 0.03;
    const z = (vi - mu) / sd;

    let preMin = Infinity;
    for (let j = Math.max(0, i - preW); j <= i; j++) if (v[j] < preMin) preMin = v[j];
    let postMin = Infinity;
    for (let j = i; j <= i + postW; j++) if (v[j] < postMin) postMin = v[j];

    const riseZ = (vi - preMin) / sd;
    const troughZ = (vi - postMin) / sd;

    let zY = 0;
    if (yawUsable) {
      const ym = (py[i + 1] - py[lo]) / c;
      const ysd = Math.sqrt(Math.max(0, (py2[i + 1] - py2[lo]) / c - ym * ym)) || 0.01;
      zY = (Math.abs(yaw[i]) - ym) / ysd;
    }

    const score = 0.5 * Math.min(troughZ, 6) + 0.3 * z + 0.2 * Math.max(0, Math.min(zY, 3));

    out.push({ t: t[i], index: i, z, riseZ, troughZ, zY, amp: vi, score, yaw: yaw ? yaw[i] : 0 });
  }
  return out;
}

/** One step per cluster, keeping the best-supported peak. */
function suppressDuplicates(candidates, gap) {
  const sorted = [...candidates].sort((a, b) => a.t - b.t);
  const clusters = [];
  let cur = null;
  for (const c of sorted) {
    if (cur && c.t - cur[cur.length - 1].t < gap) cur.push(c);
    else { cur = [c]; clusters.push(cur); }
  }
  const out = [];
  for (const cl of clusters) {
    let best = null, bestTrough = 0;
    for (const c of cl) {
      if (!best || c.score > best.score) best = c;
      if (c.troughZ > bestTrough) bestTrough = c.troughZ;
    }
    best.clusterTrough = bestTrough;
    best.clusterSize = cl.length;
    out.push(best);
  }
  return out;
}

function passesCandidate(c, p) {
  if (c.z < p.zPeak) return false;
  if (c.troughZ >= p.troughMin && c.riseZ >= p.riseMin && c.score >= p.scoreMin) return true;
  // A weak limb may produce a small vertical impact but still rotates the
  // pelvis normally. Accept those only when the rotation channel is strong,
  // so tonal shuffle noise (vertical only) cannot sneak in.
  return c.troughZ >= p.weakTrough && c.zY >= p.weakYawZ && c.score >= p.weakScore;
}

/**
 * Full detection over an array. Suitable for post-session analysis and for
 * the live tracker (which calls it on a sliding window).
 *
 * @param {boolean} opts.fill recover steps from doubled intervals
 */
export function detectSteps(t, v, yaw, params = DEFAULT_PARAMS, opts = {}) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const cands = findCandidates(t, v, yaw, p);
  const clustered = suppressDuplicates(cands, p.clusterGap);

  // Interval filtering.
  const accepted = [];
  const intervals = [];
  let lastT = -Infinity;
  let med = null;
  for (const c of clustered) {
    if (!passesCandidate(c, p)) continue;
    const refractory = med != null
      ? Math.min(0.55, Math.max(p.minInterval, p.refractoryFactor * med))
      : p.minInterval;
    if (c.t - lastT < refractory) continue;
    if (med != null && c.t - lastT > p.maxInterval) { intervals.length = 0; med = null; }

    accepted.push(c);
    if (lastT > -Infinity) {
      intervals.push(c.t - lastT);
      med = medianOf(intervals.slice(-8));
    }
    lastT = c.t;
  }

  const timed = accepted.map((c) => ({
    t: c.t,
    index: c.index,
    amp: c.amp,
    strength: c.troughZ,
    prominence: c.riseZ,
    zA: c.z,
    zY: c.zY,
    yaw: c.yaw,
    interval: null,
  }));
  for (let i = 1; i < timed.length; i++) timed[i].interval = timed[i].t - timed[i - 1].t;

  return opts.fill === false ? timed : recoverMissedSteps(timed, clustered, p);
}

/**
 * If two consecutive steps are ~2× the median interval apart, a weak paretic
 * step was probably missed. Look for the best-supported candidate near the
 * midpoint and insert it.
 */
export function recoverMissedSteps(steps, candidates, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  if (steps.length < 6) return steps;

  const baseInt = medianOf(steps.slice(1).map((s) => s.interval).filter(Boolean));
  if (!baseInt) return steps;
  const troughs = steps.map((s) => s.strength);
  const medTrough = medianOf(troughs);
  const scores = steps.map((s) => 0.5 * Math.min(s.strength, 6) + 0.3 * s.zA + 0.2 * Math.max(0, Math.min(s.zY, 3)));
  const medScore = medianOf(scores);

  const byTime = [...candidates].sort((a, b) => a.t - b.t);
  const out = [steps[0]];

  for (let i = 1; i < steps.length; i++) {
    const prev = out[out.length - 1];
    const cur = steps[i];
    const dt = cur.t - prev.t;
    if (dt > p.fillGapLo * baseInt && dt < p.fillGapHi * baseInt) {
      const lo = prev.t + 0.34 * dt;
      const hi = prev.t + 0.66 * dt;
      let best = null, bestScore = -Infinity;
      for (const c of byTime) {
        if (c.t <= lo) continue;
        if (c.t >= hi) break;
        if (c.t - prev.t < 0.4 * baseInt || cur.t - c.t < 0.4 * baseInt) continue;
        if (c.troughZ < p.fillTroughRatio * medTrough) continue;
        if (c.score < p.fillScoreRatio * medScore) continue;
        if (c.score > bestScore) { best = c; bestScore = c.score; }
      }
      if (best) {
        const s = {
          t: best.t, index: best.index, amp: best.amp, strength: best.troughZ,
          prominence: best.riseZ, zA: best.z, zY: best.zY, yaw: best.yaw,
          interval: best.t - prev.t, recovered: true,
        };
        out.push(s);
      }
    }
    out.push({ ...cur, interval: cur.t - out[out.length - 1].t });
  }
  return out;
}

/** Assign each step to side A/B from the sign of vertical angular velocity. */
export function assignSides(steps) {
  if (steps.length < 2) return { sides: steps.map(() => 0), alternation: 0, source: 'none' };
  const raw = steps.map((s) => (s.yaw >= 0 ? 1 : -1));
  let alt = 0;
  for (let i = 1; i < raw.length; i++) if (raw[i] !== raw[i - 1]) alt++;
  const alternation = alt / (raw.length - 1);
  if (alternation >= 0.68) {
    return { sides: raw.map((r) => (r > 0 ? 0 : 1)), alternation, source: 'rotation' };
  }
  return { sides: steps.map((_, i) => i % 2), alternation, source: 'parity' };
}

export function cadenceAt(steps, now, window = 8) {
  const recent = steps.filter((s) => s.t > now - window);
  if (recent.length < 2) return 0;
  const span = recent[recent.length - 1].t - recent[0].t;
  return span > 0 ? ((recent.length - 1) / span) * 60 : 0;
}

function trimmedMean(a, frac) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const cut = Math.floor(b.length * frac);
  const s = b.slice(cut, Math.max(cut + 1, b.length - cut));
  return s.reduce((x, y) => x + y, 0) / s.length;
}

export function summarize(steps) {
  const n = steps.length;
  if (n < 2) {
    return {
      steps: n, cadence: 0, duration: 0, meanInterval: 0, intervalCV: 0,
      asymmetry: 0, asymmetrySigned: 0, asymmetrySource: 'none', alternation: 0,
      sides: [], intervals: [], leftCount: 0, rightCount: 0, meanAmplitude: 0,
      quality: 0, qualityLabel: '낮음', reasons: [],
    };
  }

  const intervals = [];
  for (let i = 1; i < n; i++) {
    const d = steps[i].t - steps[i - 1].t;
    if (d >= 0.22 && d <= 3.2) intervals.push(d);
  }
  const meanInterval = intervals.length ? intervals.reduce((a, b) => a + b, 0) / intervals.length : 0;
  const varr = intervals.length > 1
    ? intervals.reduce((s, x) => s + (x - meanInterval) ** 2, 0) / (intervals.length - 1)
    : 0;
  const intervalCV = meanInterval > 0 ? (Math.sqrt(varr) / meanInterval) * 100 : 0;

  const { sides, alternation, source } = assignSides(steps);
  const groups = [[], []];
  for (let i = 1; i < n; i++) {
    const d = steps[i].t - steps[i - 1].t;
    if (d < 0.22 || d > 3.2) continue;
    groups[sides[i]].push(d);
  }
  const a = trimmedMean(groups[0], 0.1);
  const b = trimmedMean(groups[1], 0.1);
  const denom = (a + b) / 2;
  const duration = steps[n - 1].t - steps[0].t;
  const cadence = duration > 0 ? ((n - 1) / duration) * 60 : 0;

  return {
    steps: n,
    cadence,
    duration,
    meanInterval,
    intervalCV,
    asymmetry: denom > 0 ? (Math.abs(a - b) / denom) * 100 : 0,
    asymmetrySigned: denom > 0 ? ((a - b) / denom) * 100 : 0,
    asymmetrySource: source,
    alternation,
    sides,
    intervals,
    leftCount: sides.filter((s) => s === 0).length,
    rightCount: sides.filter((s) => s === 1).length,
    meanAmplitude: medianOf(steps.map((s) => s.amp)),
    quality: 0,
    qualityLabel: '낮음',
    reasons: [],
  };
}

function normAc(x, lag) {
  let num = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < x.length - lag; i++) {
    num += x[i] * x[i + lag];
    d1 += x[i] * x[i];
    d2 += x[i + lag] * x[i + lag];
  }
  const den = Math.sqrt(d1 * d2);
  return den > EPS ? num / den : 0;
}

export function assessQuality(t, v, yaw, steps, params = DEFAULT_PARAMS) {
  const p = { ...DEFAULT_PARAMS, ...params };
  const fs = p.fs;
  const n = Math.min(t.length, v.length);
  const reasons = [];
  if (n < fs * 3) return { score: 0, label: '낮음', ac: 0, reasons: ['기록이 너무 짧습니다'] };

  const summ = summarize(steps);
  const lagSec = summ.meanInterval || 0.75;
  const w = Math.min(n, Math.round(Math.min(10, n / fs) * fs));
  const seg = Array.from(v.slice(n - w, n));
  const mu = seg.reduce((a, b) => a + b, 0) / seg.length;
  for (let i = 0; i < seg.length; i++) seg[i] -= mu;

  const center = Math.round(lagSec * fs);
  let bestAc = 0;
  for (let lag = Math.max(8, center - 3); lag <= Math.min(seg.length - 8, center + 3); lag++) {
    const ac = normAc(seg, lag);
    if (ac > bestAc) bestAc = ac;
  }
  if (bestAc < 0.35) reasons.push('보행 주기 신호가 약합니다');

  const cvScore = Math.exp(-Math.max(0, summ.intervalCV - 4) / 18) * 100;
  if (summ.intervalCV > 25) reasons.push('걸음 간격 변동이 큽니다');

  const amps = steps.map((s) => s.strength);
  const medAmp = medianOf(amps);
  const ampScore = Math.min(100, (medAmp / 2.2) * 100);
  if (medAmp < 0.8) reasons.push('충격 신호가 작습니다');

  let altScore = 50;
  if (summ.asymmetrySource === 'rotation') {
    altScore = Math.min(100, (summ.alternation / 0.9) * 100);
    if (summ.alternation < 0.7) reasons.push('좌우 교대가 불규칙합니다');
  }

  const ampGroups = [[], []];
  summ.sides.forEach((s, i) => { if (amps[i] != null) ampGroups[s].push(amps[i]); });
  const ga = medianOf(ampGroups[0]);
  const gb = medianOf(ampGroups[1]);
  const ratio = Math.max(ga, gb) / Math.max(EPS, Math.min(ga, gb));
  if (ratio > 2.4) reasons.push('보조기구 충격이 섞였을 수 있습니다');

  const score = Math.max(0, Math.min(100,
    0.36 * bestAc * 100 + 0.26 * cvScore + 0.22 * ampScore + 0.16 * altScore
    - (ratio > 2.4 ? 6 : 0)));

  const label = score >= 75 ? '높음' : score >= 50 ? '보통' : '낮음';
  if (!reasons.length && label !== '높음') reasons.push('전반적인 신호 세기가 약합니다');

  return { score, label, ac: bestAc, reasons, ampRatio: ratio };
}

/**
 * Incremental tracker for the live view. Re-runs detection on a bounded
 * window; only steps older than `confirmDelay` are emitted.
 */
export class StepTracker {
  constructor(params = DEFAULT_PARAMS) {
    this.params = { ...DEFAULT_PARAMS, ...params };
    this.steps = [];
    this.lastEmitted = -Infinity;
    this.windowSec = 30;
  }

  reset() { this.steps = []; this.lastEmitted = -Infinity; }

  update(sig, now) {
    const { t, v, yaw } = sig;
    if (t.length < this.params.fs) return [];
    const cutoff = now - this.params.confirmDelay;
    const found = detectSteps(t, v, yaw, this.params, { fill: false });
    const fresh = [];
    for (const s of found) {
      if (s.t > this.lastEmitted + 0.05 && s.t <= cutoff) {
        this.steps.push(s);
        this.lastEmitted = s.t;
        fresh.push(s);
      }
    }
    return fresh;
  }

  /** Final pass on the whole recording, including missed-step recovery. */
  finalize(t, v, yaw) {
    return detectSteps(t, v, yaw, this.params, { fill: true });
  }
}
