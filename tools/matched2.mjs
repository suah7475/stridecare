import { GaitSignal } from '../js/core/dsp.js';
import { simulateGait, PROFILES } from '../js/core/simulator.js';

const fs = 50;
function buildKernel() {
  const K = Math.round(0.34 * fs);
  const k = new Float64Array(K + 1);
  let mean = 0;
  for (let i = 0; i <= K; i++) {
    const u = i / fs;
    k[i] = Math.exp(-0.5 * (u / 0.055) ** 2) - 0.58 * Math.exp(-0.5 * ((u - 0.115) / 0.075) ** 2);
    mean += k[i];
  }
  mean /= (K + 1);
  let norm = 0;
  for (let i = 0; i <= K; i++) { k[i] -= mean; norm += k[i] * k[i]; }
  norm = Math.sqrt(norm);
  for (let i = 0; i <= K; i++) k[i] /= norm;
  return k;
}
const KERNEL = buildKernel();
function matched(v) {
  const n = v.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let j = 0; j < KERNEL.length && j <= i; j++) s += KERNEL[j] * v[i - j];
    out[i] = s;
  }
  return out;
}

function rollingZ(x, i, win = 200) {
  const lo = Math.max(0, i - win);
  let s = 0, s2 = 0, c = 0;
  for (let j = lo; j <= i; j++) { s += x[j]; s2 += x[j]*x[j]; c++; }
  const mu = s/c, sd = Math.sqrt(Math.max(0, s2/c - mu*mu)) || 1e-6;
  return (x[i]-mu)/sd;
}

function detect(m, ay, t, p) {
  const n = m.length, out = [];
  let lastT = -1;
  for (let i = 3; i < n - 3; i++) {
    if (m[i] <= 0) continue;
    if (!(m[i] >= m[i-1] && m[i] > m[i+1] && m[i] >= m[i-2] && m[i] > m[i+2])) continue;
    const zA = rollingZ(m, i, 200);
    if (zA < p.kA) continue;
    const zY = Math.abs(ay[i]) / (Math.abs(ay[i-1]) + 1e-6) > 0 ? Math.abs(rollingZAbs(ay, i, 200)) : 0;
    const score = 0.7*zA + 0.3*zY;
    if (score < p.kS) continue;
    if (t[i] - lastT < p.minInt) continue;
    out.push(t[i]); lastT = t[i];
  }
  return out;
}
function rollingZAbs(x, i, win = 200) {
  const lo = Math.max(0, i - win);
  let s = 0, s2 = 0, c = 0;
  for (let j = lo; j <= i; j++) { const a = Math.abs(x[j]); s += a; s2 += a*a; c++; }
  const mu = s/c, sd = Math.sqrt(Math.max(0, s2/c - mu*mu)) || 1e-6;
  return (Math.abs(x[i])-mu)/sd;
}

for (const key of Object.keys(PROFILES)) {
  const data = simulateGait({ duration: 60, seed: 1, profile: PROFILES[key] });
  const sig = new GaitSignal();
  for (let i = 0; i < data.t.length; i++) {
    sig.pushRaw(data.t[i], data.ax[i], data.ay[i], data.az[i], data.gx[i], data.gy[i], data.gz[i]);
    if (i % 5 === 4) sig.pump(data.t[i]);
  }
  sig.pump(data.t[data.t.length-1] + 0.2);
  const m = matched(Float32Array.from(sig.v));
  let best = null;
  for (const kA of [0.6, 0.9, 1.2, 1.5]) {
    for (const kS of [1.0, 1.2, 1.4, 1.6]) {
      for (const mi of [0.3, 0.45, 0.6]) {
        const p = detect(m, sig.yaw, sig.t, { kA, kS, minInt: mi });
        const err = Math.abs(p.length - data.truth.steps) / data.truth.steps;
        if (!best || err < best.err) best = { kA, kS, mi, n: p.length, err };
      }
    }
  }
  console.log(key.padEnd(12), 'true', data.truth.steps, 'best', JSON.stringify(best));
}
