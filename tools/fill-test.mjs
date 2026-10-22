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
    out.push({ t:t[i], index:i, z:(vi-mu)/sd, riseZ:(vi-preMin)/sd, troughZ:(vi-postMin)/sd, zY:(Math.abs(yaw[i])-ym)/ysd, amp:vi });
  }
  return out;
}

function medOf(a){const b=[...a].sort((x,y)=>x-y);return b[b.length>>1] ?? 0;}

function select(cands, p) {
  const sorted = [...cands].sort((a,b)=>a.t-b.t);
  const clusters = [];
  for (const c of sorted) {
    const last = clusters[clusters.length-1];
    if (last && c.t - last[last.length-1].t < p.clusterGap) last.push(c);
    else clusters.push([c]);
  }
  let picked = [];
  for (const cl of clusters) {
    let best=null,bestS=-Infinity,bestTrough=0;
    for (const c of cl) {
      const s = 0.5*Math.min(c.troughZ,6)+0.3*c.z+0.2*Math.max(0,Math.min(c.zY,3));
      if (s>bestS){bestS=s;best=c;}
      bestTrough=Math.max(bestTrough,c.troughZ);
    }
    if (bestTrough < p.troughMin || best.z < p.zMin || bestS < p.scoreMin) continue;
    picked.push({...best,cScore:bestS});
  }
  const out=[]; let lastT=-Infinity, med=null; const ints=[];
  for (const c of picked) {
    const refr = med ? Math.max(p.minInt, p.refrFactor*med) : p.minInt;
    if (c.t-lastT < refr) continue;
    if (med && c.t-lastT > 2.6) {ints.length=0;med=null;}
    out.push(c);
    if (lastT>-Infinity){ints.push(c.t-lastT);med=medOf(ints);}
    lastT=c.t;
  }
  return { out, med };
}

function fillGaps(steps, cands, p) {
  if (steps.length < 6) return steps;
  const ints = [];
  for (let i=1;i<steps.length;i++) ints.push(steps[i].t-steps[i-1].t);
  const med = medOf(ints);
  if (!med) return steps;
  const out = [steps[0]];
  for (let i=1;i<steps.length;i++) {
    const prev = out[out.length-1], cur = steps[i];
    const dt = cur.t - prev.t;
    if (dt > p.gapLo*med && dt < p.gapHi*med) {
      const a = prev.t + 0.34*dt, b = prev.t + 0.66*dt;
      let best=null;
      for (const c of cands) {
        if (c.t < a || c.t > b) continue;
        if (c.t-prev.t < 0.4*med || cur.t-c.t < 0.4*med) continue;
        if (c.troughZ < p.fillTrough) continue;
        const s = c.troughZ + 0.3*c.z + 0.2*Math.max(0,c.zY);
        if (!best || s > best.s) best = { ...c, s };
      }
      if (best) out.push(best);
    }
    out.push(cur);
  }
  return out;
}

const seeds=[1,2,3], cache=[];
for (const key of Object.keys(PROFILES)) for (const seed of seeds) {
  const data = simulateGait({duration:90,seed,profile:PROFILES[key]});
  const sig = new GaitSignal();
  for (let i=0;i<data.t.length;i++){sig.pushRaw(data.t[i],data.ax[i],data.ay[i],data.az[i],data.gx[i],data.gy[i],data.gz[i]); if(i%7===6)sig.pump(data.t[i]);}
  sig.pump(data.t[data.t.length-1]+0.2);
  cache.push({key,truth:data.truth.steps,cands:candidates(sig.t,sig.v,sig.yaw)});
}

const base = {clusterGap:0.24,troughMin:0.55,zMin:0.3,scoreMin:1.7,minInt:0.3,refrFactor:0.45};
console.log('no fill');
for (const key of Object.keys(PROFILES)) {
  console.log(key.padEnd(12), cache.filter(c=>c.key===key).map(c=>{
    const {out}=select(c.cands,base); return `${c.truth}->${out.length}(${((out.length-c.truth)/c.truth*100).toFixed(1)}%)`;
  }).join('  '));
}
let best=null;
for (const troughMin of [0.3,0.5,0.8])
for (const gapLo of [1.5,1.65,1.8])
for (const gapHi of [2.4,2.8])
for (const fillTrough of [0.3,0.6,0.9]) {
  const p={...base,gapLo,gapHi,fillTrough};
  let total=0,maxE=0;
  for (const c of cache) {
    const {out}=select(c.cands,p);
    const filled=fillGaps(out,c.cands,p);
    const e=Math.abs(filled.length-c.truth)/c.truth;
    total+=e;maxE=Math.max(maxE,e);
  }
  const mean=total/cache.length;
  if(!best||mean<best.mean)best={p,mean,maxE};
}
console.log('\nBEST FILL', JSON.stringify(best));
for (const key of Object.keys(PROFILES)) {
  console.log(key.padEnd(12), cache.filter(c=>c.key===key).map(c=>{
    const {out}=select(c.cands,best.p); const f=fillGaps(out,c.cands,best.p);
    return `${c.truth}->${f.length}(${((f.length-c.truth)/c.truth*100).toFixed(1)}%)`;
  }).join('  '));
}
