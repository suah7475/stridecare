import { GaitSignal } from '../js/core/dsp.js';
import { detectSteps, DEFAULT_PARAMS } from '../js/core/detector.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const up = [0.16, 0.955, 0.25];
const un = Math.hypot(...up);
const u = up.map(x => x / un);

const data = simulateGait({ duration: 14, seed: 1, profile: PROFILES.hemiparetic });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 5 === 4) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length - 1] + 0.2);

console.log('truth', data.truth.times.map(x => x.toFixed(2)).join(' '));
console.log('samples', sig.t.length, 'duration', sig.duration.toFixed(2));
console.log('first t', sig.t[0], 'last', sig.t[sig.t.length-1]);

// true vertical from raw
function trueV(i) {
  const g = 9.81;
  const ax = data.ax[i] - g * u[0], ay = data.ay[i] - g * u[1], az = data.az[i] - g * u[2];
  return ax * u[0] + ay * u[1] + az * u[2];
}

const steps = detectSteps(sig.t, sig.v, sig.yaw, DEFAULT_PARAMS);
console.log('det', steps.map(s => s.t.toFixed(2)).join(' '));

console.log('\nt    rawV  filtV  yaw  det');
for (let i = 0; i < 300; i += 5) {
  const tv = trueV(i);
  const j = sig.t.findIndex(x => Math.abs(x - data.t[i]) < 0.011);
  const fv = j >= 0 ? sig.v[j] : NaN;
  const y = j >= 0 ? sig.yaw[j] : NaN;
  const d = steps.some(s => Math.abs(s.t - data.t[i]) < 0.03);
  console.log(data.t[i].toFixed(2), tv.toFixed(2).padStart(6), (fv ?? 0).toFixed(2).padStart(6), (y ?? 0).toFixed(2).padStart(6), d ? '  <--' : '');
}
