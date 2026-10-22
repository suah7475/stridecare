import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

function candidates(t, v, yaw, fs = 50) {
  const n = v.length, out = [];
  const W = 4*fs, preW = Math.round(0.35*fs), postW = Math.round(0.28*fs);
  for (let i = 5; i < n - postW; i++) {
    const vi = v[i];
    if (vi <= 0.02) continue;
    let peak = true;
    for (let k = 1; k <= 2; k++) if (v[i-k] > vi || v[i+k] >= vi) { peak = false; break; }
    if (!peak) continue;
    const lo = Math.max(0, i - W);
    if (i - lo < fs) continue;
    let s=0,s2=0;
    for (let j=lo;j<=i;j++){s+=v[j];s2+=v[j]*v[j];}
    const c=i-lo+1, mu=s/c, sd=Math.sqrt(Math.max(0,s2/c-mu*mu))||0.03;
    let preMin=Infinity, postMin=Infinity;
    for (let j=Math.max(0,i-preW);j<=i;j++) preMin=Math.min(preMin,v[j]);
    for (let j=i;j<=i+postW;j++) postMin=Math.min(postMin,v[j]);
    let ys=0,ys2=0,yc=0;
    for (let j=lo;j<=i;j++){const a=Math.abs(yaw[j]);ys+=a;ys2+=yaw[j]*yaw[j];yc++;}
    const ym=ys/yc, ysd=Math.sqrt(Math.max(0,ys2/yc-ym*ym))||0.01;
    out.push({ t:t[i], z:(vi-mu)/sd, riseZ:(vi-preMin)/sd, troughZ:(vi-postMin)/sd, zY:(Math.abs(yaw[i])-ym)/ysd, amp:vi });
  }
  return out;
}

function select(cands, p) {
  // 1. greedy non-maximum suppression by time
  const sorted = [...cands].sort((a,b)=>a.t-b.t);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length-1];
    if (last && c.t - last[last.length-1].t < p.clusterGap) last.push(c);
    else clusters.push([c]);
  }
  // 2. per-cluster pick by combined score
  const picked = [];
  for (const cl of clusters) {
    let best = null, bestS = -Infinity, bestTrough = 0;
    for (const c of cl) {
      const s = 0.5*Math.min(c.troughZ,6) + 0.3*c.z + 0.2*Math.max(0,Math.min(c.zY,3));
      if (s > bestS) { bestS = s; best = c; }
      bestTrough = Math.max(bestTrough, c.troughZ);
    }
    if (bestTrough < p.troughMin) continue;
    if (best.z < p.zMin) continue;
    if (bestS < p.scoreMin) continue;
    picked.push({ ...best, cScore: bestS, cTrough: bestTrough });
  }
  // 3. interval filter
  const out = [];
  let lastT = -Infinity, med = null;
  const ints = [];
  for (const c of picked) {
    const refr = med ? Math.max(p.minInt, p.refrFactor*med) : p.minInt;
    if (c.t - lastT < refr) continue;
    if (med && c.t - lastT > 2.6) { ints.length = 0; med = null; }
    out.push(c);
    if (lastT > -Infinity) { ints.push(c.t-lastT); const b=[...ints].sort((x,y)=>x-y); med=b[b.length>>1]; }
    lastT = c.t;
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
    sig.pump(data.t[data.t.length-1]+0.2);
    cache.push({ key, truth: data.truth.steps, cands: candidates(sig.t, sig.v, sig.yaw) });
  }
}

let best = null;
for (const clusterGap of [0.22, 0.3, 0.38])
for (const troughMin of [0.6, 0.9, 1.2, 1.5])
for (const zMin of [0.3, 0.6])
for (const scoreMin of [1.0, 1.4, 1.8])
for (const minInt of [0.3, 0.4])
for (const refrFactor of [0.45, 0.6]) {
  const p = { clusterGap, troughMin, zMin, scoreMin, minInt, refrFactor };
  let total = 0, maxE = 0;
  for (const c of cache) {
    const n = select(c.cands, p).length;
    const e = Math.abs(n-c.truth)/c.truth;
    total += e; maxE = Math.max(maxE,e);
  }
  const mean = total/cache.length;
  if (!best || mean < best.mean) best = { p, mean, maxE };
}
console.log('BEST', JSON.stringify(best));
for (const key of Object.keys(PROFILES)) {
  const rs = cache.filter(c=>c.key===key).map(c=>{
    const n=select(c.cands,best.p).length;
    return `${c.truth}->${n}(${((n-c.truth)/c.truth*100).toFixed(1)}%)`;
  });
  console.log(key.padEnd(12), rs.join('  '));
}
