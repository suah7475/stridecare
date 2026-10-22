import { buildHeelStrikeKernel } from '../js/core/dsp.js';

const fs = 50;
const k = buildHeelStrikeKernel(fs);
const n = 700;
const v = new Float64Array(n);
// pulses at 3.00 and 3.55 s
for (const t0 of [3.0, 3.55]) {
  for (let i = 0; i < n; i++) {
    const u = i/fs - t0;
    v[i] += Math.exp(-0.5*(u/0.055)**2) - 0.58*Math.exp(-0.5*((u-0.115)/0.075)**2);
  }
}
function conv(x, kernel) {
  const o = new Float64Array(n);
  for (let i = 0; i < n; i++) for (let j = 0; j < kernel.length && j <= i; j++) o[i] += kernel[j]*x[i-j];
  return o;
}
function peaks(y) {
  const out = [];
  for (let i = 2; i < n-2; i++) if (y[i] > 0.1 && y[i] >= y[i-1] && y[i] > y[i+1] && y[i] >= y[i-2] && y[i] > y[i+2]) out.push([i/fs, y[i]]);
  return out;
}
console.log('kernel first/last nonzero', k.findIndex(x=>Math.abs(x)>1e-4)/fs, (k.length-1)/fs);
console.log('direct kernel peaks', peaks(conv(v,k)).map(([t,a])=>`${t.toFixed(2)}/${a.toFixed(2)}`).join(' '));

// shifted kernel by D=0.17: place template peak at lag D
function shiftedKernel(D) {
  const K = Math.round((0.34+D)*fs);
  const a = new Float64Array(K+1);
  for (let i = 0; i <= K; i++) {
    const u = i/fs - D;
    a[i] = Math.exp(-0.5*(u/0.055)**2) - 0.58*Math.exp(-0.5*((u-0.115)/0.075)**2);
  }
  // zero-mean + norm
  let m = 0; for (const x of a) m += x; m /= a.length;
  let nn = 0; for (let i=0;i<a.length;i++){a[i]-=m; nn+=a[i]*a[i];}
  nn=Math.sqrt(nn); for (let i=0;i<a.length;i++) a[i]/=nn;
  return a;
}
const D = 0.17;
const ks = shiftedKernel(D);
console.log('shifted peaks', peaks(conv(v,ks)).map(([t,a])=>`${t.toFixed(2)}/${a.toFixed(2)}`).join(' '), '(+D?)');
