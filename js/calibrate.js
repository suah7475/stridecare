/**
 * StrideCare — patient-specific calibration
 *
 * A single global threshold cannot fit every stroke gait: a walking patient
 * with a heavy paretic drop may need a low trough threshold, while a patient
 * with a cane needs a high fill threshold to avoid counting the cane tap.
 *
 * This module searches a small, clinically bounded parameter grid against one
 * observer-counted recording. The search deliberately stays close to the
 * standard preset when several settings produce the same count, so a single
 * walk cannot push the detector into an extreme configuration.
 */

import { detectSteps, DEFAULT_PARAMS } from './core/detector.js';

const GRID = {
  zPeak: [0.25, 0.35, 0.45, 0.55, 0.65, 0.75],
  troughMin: [0.25, 0.4, 0.55, 0.7],
  scoreMin: [1.1, 1.35, 1.6, 1.85],
  fillTroughRatio: [0.15, 0.3, 0.45, 0.6],
};

function median(a) {
  if (!a.length) return 0;
  const b = a.slice().sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

function clampToGrid(values, value) {
  let best = values[0];
  let dist = Infinity;
  for (const v of values) {
    const d = Math.abs(v - value);
    if (d < dist) { best = v; dist = d; }
  }
  return best;
}

function deviation(p) {
  return Math.abs(p.zPeak - 0.45) / 0.45
    + Math.abs(p.troughMin - 0.5) / 0.5
    + Math.abs(p.scoreMin - 1.6) / 1.6
    + Math.abs(p.fillTroughRatio - 0.25) / 0.25;
}

/**
 * Count steps for one parameter set. The median interval is also returned so
 * an implausibly fast result (double counting) can be penalised.
 */
function evaluate(t, v, yaw, overrides, base) {
  const params = { ...DEFAULT_PARAMS, ...base, ...overrides, fs: DEFAULT_PARAMS.fs };
  const steps = detectSteps(t, v, yaw, params, { fill: true });
  const intervals = [];
  for (let i = 1; i < steps.length; i++) {
    const d = steps[i].t - steps[i - 1].t;
    if (d > 0.2 && d < 3.5) intervals.push(d);
  }
  return { steps, count: steps.length, medInterval: median(intervals) };
}

/**
 * Grid search with a coarse pass and a local refinement pass.
 *
 * @param {number[]} t  uniform 50 Hz time axis (seconds)
 * @param {number[]} v  band-passed vertical acceleration
 * @param {number[]} yaw vertical angular velocity
 * @param {number} targetCount observer count
 * @param {{base?:object, maxRuns?:number, minCount?:number}} opts
 */
export function calibrate(t, v, yaw, targetCount, opts = {}) {
  const target = Math.round(Number(targetCount));
  const base = opts.base || {};
  const n = Math.min(t?.length || 0, v?.length || 0, yaw?.length || 0);
  if (!Number.isFinite(target) || target < 5) {
    throw new Error('관찰자 계수는 5보 이상이어야 합니다.');
  }
  if (n < 50 * 8) {
    throw new Error('보정 기록이 너무 짧습니다. 20초 이상 측정하세요.');
  }

  const duration = t[n - 1] - t[0];

  // Baseline (current configuration) for an improvement check.
  const baseline = evaluate(t, v, yaw, {}, base);
  const baselineErr = Math.abs(baseline.count - target);

  const runs = [];
  const seen = new Set();
  let count = 0;

  function tryParams(p) {
    const key = `${p.zPeak}|${p.troughMin}|${p.scoreMin}|${p.fillTroughRatio}`;
    if (seen.has(key)) return;
    seen.add(key);
    const r = evaluate(t, v, yaw, p, base);
    count++;
    // Prefer the smallest absolute count error; break ties with proximity to
    // the standard preset and a cadence plausibility guard.
    const err = Math.abs(r.count - target);
    const cadence = r.medInterval > 0 ? 60 / r.medInterval : 0;
    const cadencePenalty = cadence > 145 ? 0.6 : cadence > 0 && cadence < 35 ? 0.4 : 0;
    const total = err + 0.035 * deviation(p) + cadencePenalty;
    runs.push({ ...p, count: r.count, err, cadence, total });
  }

  // Coarse pass.
  for (const zPeak of GRID.zPeak) {
    for (const troughMin of GRID.troughMin) {
      for (const scoreMin of GRID.scoreMin) {
        for (const fillTroughRatio of GRID.fillTroughRatio) {
          tryParams({ zPeak, troughMin, scoreMin, fillTroughRatio });
        }
      }
    }
  }

  let best = runs.reduce((a, b) => (b.total < a.total ? b : a), runs[0]);

  // Local refinement: two neighbouring values on each axis.
  const near = (values, value) => {
    const i = values.indexOf(clampToGrid(values, value));
    return [values[Math.max(0, i - 1)], values[i], values[Math.min(values.length - 1, i + 1)]];
  };
  for (const zPeak of near(GRID.zPeak, best.zPeak)) {
    for (const troughMin of near(GRID.troughMin, best.troughMin)) {
      for (const scoreMin of near(GRID.scoreMin, best.scoreMin)) {
        for (const fillTroughRatio of near(GRID.fillTroughRatio, best.fillTroughRatio)) {
          tryParams({ zPeak, troughMin, scoreMin, fillTroughRatio });
          if (count >= (opts.maxRuns || 240)) break;
        }
      }
    }
  }

  best = runs.reduce((a, b) => (b.total < a.total ? b : a), best);

  const errorSteps = best.count - target;
  const errorPct = target > 0 ? (errorSteps / target) * 100 : 0;
  const baselineErrorPct = target > 0 ? (baseline.count - target) / target * 100 : 0;
  const tuned = {
    zPeak: best.zPeak,
    troughMin: best.troughMin,
    scoreMin: best.scoreMin,
    fillTroughRatio: best.fillTroughRatio,
  };

  return {
    ok: Math.abs(errorPct) <= 12,
    improved: Math.abs(errorSteps) < baselineErr,
    params: tuned,
    target,
    count: best.count,
    errorSteps,
    errorPct,
    baselineCount: baseline.count,
    baselineErrorPct,
    durationSec: duration,
    runs: runs.length,
    cadence: best.cadence,
    gridSize: GRID,
  };
}

// Backwards-friendly alias used by the UI.
export const calibrateRecording = calibrate;
