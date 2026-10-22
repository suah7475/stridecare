import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const data = simulateGait({ duration: 12, seed: 1, profile: PROFILES.healthy });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 7 === 6) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length-1] + 0.2);

const up = [0.16, 0.955, 0.25]; const un = Math.hypot(...up); const u = up.map(x=>x/un);
console.log('truth', data.truth.times.slice(0,20).map(x=>x.toFixed(2)).join(' '));

let bestm = -1, besti = -1;
for (let i = 0; i < sig.m.length; i++) if (sig.t[i] > 3 && sig.t[i] < 6 && sig.m[i] > bestm) { bestm = sig.m[i]; besti = i; }
console.log('max m in 3-6s at', sig.t[besti].toFixed(2), bestm.toFixed(2));
console.log('\nt     v      m');
for (let i = 0; i < sig.t.length; i++) {
  if (sig.t[i] < 4.6 || sig.t[i] > 5.9) continue;
  if (i % 2) continue;
  console.log(sig.t[i].toFixed(2), sig.v[i].toFixed(2).padStart(6), sig.m[i].toFixed(2).padStart(6));
}
