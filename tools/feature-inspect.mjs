import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

function feats(t, v, yaw, fs = 50) {
  const n = v.length, out = [];
  const W = 4*fs, preW = 0.35*fs, postW = 0.28*fs;
  for (let i = 4; i < n - postW; i++) {
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

const data = simulateGait({ duration: 30, seed: 1, profile: PROFILES.hemiparetic });
const sig = new GaitSignal();
for (let i = 0; i < data.t.length; i++) {
  sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
  if (i % 7 === 6) sig.pump(data.t[i]);
}
sig.pump(data.t[data.t.length-1]+0.2);
const cands = feats(sig.t, sig.v, sig.yaw);
const truth = data.truth.times;
const rows = cands.filter(c=>c.t>3&&c.t<12).map(c=>{
  const near = Math.min(...truth.map(t=>Math.abs(t-c.t)));
  return { ...c, near: near < 0.15 ? 'TRUE' : `no(${near.toFixed(2)})` };
});
console.log('t      z    rise  trough  zY    near');
for (const r of rows) console.log(r.t.toFixed(2), r.z.toFixed(1).padStart(5), r.riseZ.toFixed(1).padStart(5), r.troughZ.toFixed(1).padStart(6), r.zY.toFixed(1).padStart(5), ' ', r.near);
