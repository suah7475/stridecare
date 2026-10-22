/**
 * In-browser synthetic benchmark.
 *
 * This is the same pipeline as tools/verify.mjs. It exists so a clinician can
 * inspect accuracy without installing Node, and so the claim in the UI can be
 * reproduced on the device.
 */

import { GaitSignal } from './core/dsp.js';
import { detectSteps, summarize, DEFAULT_PARAMS } from './core/detector.js';
import { simulateGait, PROFILES } from './core/simulator.js';

function pipeline(data) {
  const sig = new GaitSignal();
  const n = data.t.length;
  for (let i = 0; i < n; i++) {
    sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
    if (i % 7 === 6) sig.pump(data.t[i]);
  }
  sig.pump(data.t[n - 1] + 0.2);
  return sig;
}

const yieldToUi = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * @param {{seeds?:number[], duration?:number, onProgress?:Function}} opts
 */
export async function runBenchmark(opts = {}) {
  const seeds = opts.seeds || [1, 2, 3, 4, 5];
  const duration = opts.duration || 120;
  const rows = [];
  const keys = Object.keys(PROFILES);

  for (let ki = 0; ki < keys.length; ki++) {
    const profile = PROFILES[keys[ki]];
    for (let si = 0; si < seeds.length; si++) {
      // Let the main thread paint between cases; the full run is ~150 ms in
      // Node and should remain responsive on a phone.
      await yieldToUi();
      const data = simulateGait({ duration, seed: seeds[si], profile });
      const sig = pipeline(data);
      const steps = detectSteps(sig.t, sig.v, sig.yaw, DEFAULT_PARAMS);
      const summ = summarize(steps);
      const truth = data.truth;
      rows.push({
        profile: profile.label,
        profileKey: profile.key,
        trueSteps: truth.steps,
        detected: steps.length,
        error: steps.length - truth.steps,
        errorPct: ((steps.length - truth.steps) / truth.steps) * 100,
        trueCadence: truth.cadence,
        cadence: summ.cadence,
        trueAsymmetry: truth.asymmetry,
        asymmetry: summ.asymmetry,
      });
      opts.onProgress?.({
        done: rows.length,
        total: keys.length * seeds.length,
        profile: profile.label,
        seed: seeds[si],
      });
    }
  }

  const absPct = rows.map((r) => Math.abs(r.errorPct));
  const mape = absPct.reduce((a, b) => a + b, 0) / absPct.length;
  const maxErrorPct = Math.max(...absPct);
  const asymErrors = rows.map((r) => Math.abs(r.asymmetry - r.trueAsymmetry));
  const meanAsymError = asymErrors.reduce((a, b) => a + b, 0) / asymErrors.length;

  const byProfile = Object.keys(PROFILES).map((key) => {
    const group = rows.filter((r) => r.profileKey === key);
    const mean = group.reduce((a, r) => a + Math.abs(r.errorPct), 0) / Math.max(1, group.length);
    return {
      key,
      label: PROFILES[key].label,
      meanAbsPct: mean,
      maxAbsPct: Math.max(...group.map((r) => Math.abs(r.errorPct))),
      n: group.length,
    };
  });

  return { rows, mape, maxErrorPct, meanAsymError, byProfile, runs: rows.length, duration };
}
