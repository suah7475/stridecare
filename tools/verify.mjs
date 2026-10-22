/**
 * Offline accuracy harness.
 *
 *   node tools/verify.mjs
 *
 * Runs the exact production pipeline (resample → gravity projection →
 * band-pass → matched filter → detect → summarize) over synthetic gait
 * profiles whose true step count is known.
 */

import { GaitSignal } from '../js/core/dsp.js';
import { detectSteps, summarize, assessQuality, DEFAULT_PARAMS } from '../js/core/detector.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

function runPipeline(data) {
  const sig = new GaitSignal();
  const n = data.t.length;
  for (let i = 0; i < n; i++) {
    sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
    if (i % 7 === 6) sig.pump(data.t[i]);
  }
  sig.pump(data.t[n - 1] + 0.2);
  return sig;
}

function evaluate(profile, seed, duration = 120, params = DEFAULT_PARAMS) {
  const data = simulateGait({ duration, seed, profile });
  const sig = runPipeline(data);
  const steps = detectSteps(sig.t, sig.v, sig.yaw, params);
  const summ = summarize(steps);
  const q = assessQuality(sig.t, sig.v, sig.yaw, steps, params);
  const truth = data.truth;
  const err = steps.length - truth.steps;
  const pct = (err / truth.steps) * 100;
  return {
    profile: profile.label,
    trueSteps: truth.steps,
    detected: steps.length,
    err,
    pct,
    trueCad: truth.cadence,
    cad: summ.cadence,
    trueAsym: truth.asymmetry,
    asym: summ.asymmetry,
    cv: summ.intervalCV,
    quality: q.score,
    qLabel: q.label,
    reasons: q.reasons,
  };
}

const seeds = [1, 2, 3, 4, 5];
const rows = [];
const t0 = Date.now();

for (const key of Object.keys(PROFILES)) {
  for (const seed of seeds) rows.push(evaluate(PROFILES[key], seed, 120));
}

const pad = (s, n) => String(s).padEnd(n);
console.log(pad('profile', 18), pad('true', 6), pad('det', 6), pad('err', 6), pad('err%', 8), pad('cad', 10), pad('asym', 11), pad('q', 5));
for (const r of rows) {
  console.log(
    pad(r.profile, 18),
    pad(r.trueSteps, 6),
    pad(r.detected, 6),
    pad(r.err, 6),
    pad(r.pct.toFixed(1), 8),
    pad(`${r.cad.toFixed(1)}/${r.trueCad}`, 10),
    pad(`${r.asym.toFixed(1)}/${r.trueAsym}`, 11),
    pad(r.quality.toFixed(0), 5),
  );
}

const absPct = rows.map((r) => Math.abs(r.pct));
const mape = absPct.reduce((a, b) => a + b, 0) / absPct.length;
const maxErr = Math.max(...absPct);
const asymErr = rows.map((r) => Math.abs(r.asym - r.trueAsym));
console.log(`\nMAPE ${mape.toFixed(2)}%  max ${maxErr.toFixed(1)}%  mean |asym err| ${(asymErr.reduce((a, b) => a + b, 0) / asymErr.length).toFixed(1)}pp  (${Date.now() - t0} ms)`);

const bad = rows.filter((r) => Math.abs(r.pct) > 3);
for (const r of bad) {
  console.log('OFF:', r.profile, 'seed', r.trueSteps, '→', r.detected, `${r.pct.toFixed(1)}%`, r.reasons.join(','));
}
