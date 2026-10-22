import { GaitSignal } from '../js/core/dsp.js';
import { matchedFilter, detectSteps, DEFAULT_PARAMS } from '../js/core/detector.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const data = simulateGait({ duration: 20, seed: 1, profile: PROFILES.healthy });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 7 === 6) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length - 1] + 0.2);

const off = matchedFilter(sig.v, DEFAULT_PARAMS);
let maxDiff = 0, at = -1;
for (let i = 0; i < sig.m.length; i++) {
  const d = Math.abs(off[i] - sig.m[i]);
  if (d > maxDiff) { maxDiff = d; at = i; }
}
console.log('n', sig.m.length, sig.v.length, 'max |stream-offline|', maxDiff.toFixed(4), 'at', at, sig.t[at]);
console.log('m range', Math.min(...sig.m).toFixed(2), Math.max(...sig.m).toFixed(2), 'meanAbsYaw', (sig.yaw.reduce((a,b)=>a+Math.abs(b),0)/sig.yaw.length).toFixed(2));
console.log('truth', data.truth.times.length, data.truth.times.slice(0,8).map(x=>x.toFixed(2)).join(' '));

const steps = detectSteps(sig.t, sig.m, sig.yaw, DEFAULT_PARAMS);
console.log('det', steps.length, steps.slice(0,10).map(s=>`${s.t.toFixed(2)} zA${s.zA.toFixed(1)} zY${s.zY.toFixed(1)}`).join(' | '));
const stepsOff = detectSteps(sig.t, off, sig.yaw, DEFAULT_PARAMS);
console.log('detoff', stepsOff.length);

// yaw sample around step
const i0 = sig.t.findIndex(t => t > 5);
console.log('\nt, m, yaw');
for (let i = i0; i < i0 + 80; i += 2) console.log(sig.t[i].toFixed(2), sig.m[i].toFixed(2).padStart(6), sig.yaw[i].toFixed(2).padStart(6));
