import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

function candidateFeatures(t, v, yaw, fs = 50) {
  const n = v.length;
  const out = [];
  const W = 4 * fs, preW = Math.round(0.35 * fs), postW = Math.round(0.28 * fs);
  for (let i = 4; i < n - postW; i++) {
    const vi = v[i];
    if (vi <= 0.02) continue;
    let peak = true;
    for (let k = 1; k <= 2; k++) if (v[i-k] > vi || v[i+k] >= vi) { peak = false; break; }
    if (!peak) continue;
    const lo = Math.max(0, i - W);
    if (i - lo < fs) continue;
    let s = 0, s2 = 0;
    for (let j = lo; j <= i; j++) { s += v[j]; s2 += v[j]*v[j]; }
    const c = i-lo+1, mu = s/c, sd = Math.sqrt(Math.max(0, s2/c-mu*mu)) || 0.03;
    const z = (vi - mu)/sd;
    let preMin = Infinity, postMin = Infinity;
    for (let j = Math.max(0, i-preW); j <= i; j++) preMin = Math.min(preMin, v[j]);
    for (let j = i; j <= i+postW; j++) postMin = Math.min(postMin, v[j]);
    const riseZ = (vi - preMin)/sd;
    const troughZ = (vi - postMin)/sd;
    const yawAbs = Math.abs(yaw[i]);
    let ys = 0, ys2 = 0, yc = 0;
    for (let j = lo; j <= i; j++) { ys += Math.abs(yaw[j]); ys2 += yaw[j]*yaw[j]; yc++; }
    const ym = ys/yc, ysd = Math.sqrt(Math.max(0, ys2/yc - ym*ym)) || 0.01;
    const zY = (yawAbs - ym)/ysd;
    out.push({ i, t: t[i], z, riseZ, troughZ, zY, amp: vi });
  }
  return out;
}

function select(cands, p) {
  const out = [];
  let lastT = -Infinity;
  const ints = [];
  let medAmp = null;
  for (const c of cands) {
    if (c.z < p.zPeak) continue;
    if (c.troughZ < p.troughZ) continue;
    if (c.riseZ < p.riseZ) continue;
    const yawTerm = Math.max(0, Math.min(c.zY, 3));
    const score = 0.40*c.z + 0.30*Math.min(c.troughZ, 3) + 0.30*yawTerm;
    if (score < p.score) continue;
    if (c.t - lastT < p.minInt) continue;
    if (medAmp && out.length >= 5 && c.amp < p.ampRatio*medAmp) continue;
    out.push(c);
    lastT = c.t;
    ints.push(c.t);
    const a = out.slice(-9).map(x=>x.amp).sort((x,y)=>x-y);
    medAmp = a[a.length>>1];
  }
  return out;
}

const seeds = [1,2,3];
const cache = [];
for (const key of Object.keys(PROFILES)) {
  for (const seed of seeds) {
    const data = simulateGait({ duration: 90, seed, profile: PROFILES[key] });
    const sig = new GaitSignal();
    for (let i = 0; i < data.t.length; i++) {
      sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
      if (i % 7 === 6) sig.pump(data.t[i]);
    }
    sig.pump(data.t[data.t.length-1] + 0.2);
    cache.push({ key, truth: data.truth.steps, cands: candidateFeatures(sig.t, sig.v, sig.yaw) });
  }
}

let best = null;
for (const zPeak of [0.6, 0.8, 1.0])
for (const troughZ of [0.4, 0.7, 1.0])
for (const riseZ of [0.4, 0.7])
for (const score of [1.4, 1.7, 2.0, 2.3])
for (const minInt of [0.3, 0.42, 0.55])
for (const ampRatio of [0.35, 0.55]) {
  const p = { zPeak, troughZ, riseZ, score, minInt, ampRatio };
  let total = 0, maxE = 0;
  for (const c of cache) {
    const n = select(c.cands, p).length;
    const e = Math.abs(n - c.truth)/c.truth;
    total += e; maxE = Math.max(maxE, e);
  }
  const mean = total/cache.length;
  if (!best || mean < best.mean) best = { p, mean, maxE };
}
console.log('BEST', JSON.stringify(best));

const p = best.p;
for (const key of Object.keys(PROFILES)) {
  const rs = cache.filter(c=>c.key===key).map(c=>{
    const n = select(c.cands,p).length;
    return `${c.truth}->${n} (${((n-c.truth)/c.truth*100).toFixed(1)}%)`;
  });
  console.log(key.padEnd(12), rs.join('  '));
}
