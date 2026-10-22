import { GaitSignal } from '../js/core/dsp.js';
import { detectSteps, DEFAULT_PARAMS } from '../js/core/detector.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const data = simulateGait({ duration: 12, seed: 1, profile: PROFILES.hemiparetic });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 5 === 4) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length - 1] + 0.2);
const steps = detectSteps(sig.t, sig.v, sig.yaw, DEFAULT_PARAMS);

console.log('truth', data.truth.steps, data.truth.times.slice(0, 12).map(x => x.toFixed(2)).join(' '));
console.log('det  ', steps.length, steps.slice(0, 20).map(s => s.t.toFixed(2)).join(' '));
console.log('amps ', steps.slice(0, 20).map(s => s.amp.toFixed(2)).join(' '));

// print waveform around 5s
const idx0 = sig.t.findIndex(t => t >= 5.0);
console.log('\nt     v      yaw   peak?');
for (let i = idx0; i < idx0 + 120; i += 2) {
  const isStep = steps.some(s => Math.abs(s.t - sig.t[i]) < 0.011);
  console.log(sig.t[i].toFixed(2), sig.v[i].toFixed(2).padStart(6), sig.yaw[i].toFixed(2).padStart(6), isStep ? '  <-- STEP' : '');
}
