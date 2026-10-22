import { GaitSignal } from '../js/core/dsp.js';
import { detectSteps, DEFAULT_PARAMS } from '../js/core/detector.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const data = simulateGait({ duration: 16, seed: 1, profile: PROFILES.slow });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 5 === 4) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length - 1] + 0.2);
const steps = detectSteps(sig.t, sig.v, sig.yaw, DEFAULT_PARAMS);

console.log('truth', data.truth.times.map(x => x.toFixed(2)).join(' '));
console.log('det  ', steps.map(s => `${s.t.toFixed(2)}(${s.strength.toFixed(2)})`).join(' '));

// Find all raw local maxima above 0 within 4-10s and print strength
const cand = [];
for (let i = 2; i < sig.v.length - 2; i++) {
  if (sig.t[i] < 4 || sig.t[i] > 12) continue;
  const vi = sig.v[i];
  if (vi <= 0.05) continue;
  if (sig.v[i-1] > vi || sig.v[i+1] >= vi) continue;
  let mn = Infinity;
  for (let k = i; k <= Math.min(sig.v.length-1, i+14); k++) mn = Math.min(mn, sig.v[k]);
  cand.push([sig.t[i], vi, vi-mn]);
}
console.log('\ncandidates 4-12s: t, peak, strength');
console.log(cand.map(c => c.map(x=>x.toFixed(2)).join('/')).join('  '));
