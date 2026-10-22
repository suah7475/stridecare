import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

function ac(x, lag) {
  let n = 0, d1 = 0, d2 = 0;
  for (let i = 0; i < x.length - lag; i++) { n += x[i]*x[i+lag]; d1 += x[i]*x[i]; d2 += x[i+lag]*x[i+lag]; }
  return n / Math.sqrt(d1*d2 || 1);
}

for (const key of ['healthy','hemiparetic','slow','shuffle','cane']) {
  const data = simulateGait({ duration: 60, seed: 1, profile: PROFILES[key] });
  const sig = new GaitSignal();
  for (let i = 0; i < data.t.length; i++) {
    sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
    if (i % 5 === 4) sig.pump(data.t[i]);
  }
  sig.pump(data.t[data.t.length-1] + 0.2);
  const w = Math.round(10*50);
  const seg = Array.from(sig.v.slice(-w));
  const m = seg.reduce((a,b)=>a+b,0)/seg.length;
  for (let i=0;i<seg.length;i++) seg[i]-=m;
  const out = [];
  for (let lag=15; lag<=125; lag+=1) out.push([lag/50, ac(seg, lag)]);
  out.sort((a,b)=>b[1]-a[1]);
  const trueT = 60 / PROFILES[key].cadence;
  console.log(key, 'trueT', trueT.toFixed(2), 'top lags:',
    out.slice(0,8).map(([l,a])=>`${l.toFixed(2)}s/${a.toFixed(2)}`).join('  '));
}
