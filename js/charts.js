/**
 * StrideCare — canvas charts
 *
 * All charts are drawn at device-pixel resolution and use the same clinical
 * palette as the UI. No external chart library: the PWA must work offline and
 * the drawings are simple enough to keep dependency-free.
 */

const COLORS = {
  mint: '#35e3c2',
  mintSoft: 'rgba(53, 227, 194, 0.16)',
  blue: '#7fa6ff',
  blueSoft: 'rgba(127, 166, 255, 0.14)',
  amber: '#ffbe5c',
  red: '#ff6f6f',
  text: '#6e8098',
  textBright: '#a7b6cb',
  grid: 'rgba(255, 255, 255, 0.07)',
  gridStrong: 'rgba(255, 255, 255, 0.12)',
};

const FONT = '11px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
const FONT_SM = '10px "Pretendard Variable", Pretendard, -apple-system, sans-serif';

function prepare(canvas) {
  const rect = canvas.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width || canvas.clientWidth || 320));
  const h = Math.max(1, Math.round(rect.height || canvas.clientHeight || 160));
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  return { ctx, w, h };
}

function emptyState(ctx, w, h, title, sub = '') {
  ctx.fillStyle = COLORS.text;
  ctx.font = '12px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(title, w / 2, h / 2 - (sub ? 9 : 0));
  if (sub) {
    ctx.fillStyle = 'rgba(110, 128, 152, 0.65)';
    ctx.font = FONT_SM;
    ctx.fillText(sub, w / 2, h / 2 + 10);
  }
}

function niceDate(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

function percentileAbs(arr, q) {
  if (!arr.length) return 0;
  const b = arr.map(Math.abs).sort((a, b) => a - b);
  const pos = (b.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return b[lo] + (b[hi] - b[lo]) * (pos - lo);
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, Math.abs(w) / 2, Math.abs(h) / 2);
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, h, rr);
  } else {
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
  }
  ctx.closePath();
}

/* ------------------------------------------------------------------ */
/* Live vertical acceleration                                          */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{t:number[], v:number[], duration:number}} signal
 * @param {{t:number, side:number}[]} stepTimes
 * @param {{paused?:boolean}} opts
 */
export function drawLiveWave(canvas, signal, stepTimes = [], opts = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prepare(canvas);
  const pad = { l: 6, r: 6, t: 12, b: 18 };
  const plotW = Math.max(1, w - pad.l - pad.r);
  const plotH = Math.max(1, h - pad.t - pad.b);
  const mid = pad.t + plotH / 2;

  if (!signal || !signal.t || signal.t.length < 8) {
    emptyState(ctx, w, h, '센서 신호를 기다리는 중', '허리에 착용한 뒤 천천히 걷기 시작하세요');
    return;
  }

  const t = signal.t;
  const v = signal.v;
  const n = Math.min(t.length, v.length);
  const tEnd = t[n - 1];
  const tStart = Math.max(t[0], tEnd - (signal.duration || 8));
  const span = Math.max(0.5, tEnd - tStart);

  const range = Math.max(0.06, percentileAbs(v.slice(-Math.min(n, 260)), 0.97) * 1.12);
  const xOf = (time) => pad.l + ((time - tStart) / span) * plotW;
  const yOf = (value) => mid - (value / range) * (plotH / 2);

  // Grid + zero baseline.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.75]) {
    const y = pad.t + plotH * frac;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }
  ctx.strokeStyle = COLORS.gridStrong;
  ctx.setLineDash([3, 5]);
  ctx.beginPath();
  ctx.moveTo(pad.l, mid);
  ctx.lineTo(w - pad.r, mid);
  ctx.stroke();
  ctx.setLineDash([]);

  // Filled trace.
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  grad.addColorStop(0, 'rgba(53, 227, 194, 0.20)');
  grad.addColorStop(0.5, 'rgba(53, 227, 194, 0.045)');
  grad.addColorStop(1, 'rgba(53, 227, 194, 0.16)');

  ctx.beginPath();
  let started = false;
  for (let i = 0; i < n; i++) {
    if (t[i] < tStart) continue;
    const x = xOf(t[i]);
    const y = yOf(v[i]);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  if (started) {
    ctx.lineTo(xOf(t[n - 1]), mid);
    ctx.lineTo(xOf(Math.max(tStart, t[0])), mid);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  }

  // Step markers behind the trace.
  for (const s of stepTimes) {
    if (s.t < tStart || s.t > tEnd + 0.05) continue;
    const x = xOf(s.t);
    ctx.strokeStyle = s.side === 0 ? 'rgba(53, 227, 194, 0.28)' : 'rgba(127, 166, 255, 0.28)';
    ctx.lineWidth = 1;
    ctx.setLineDash([2, 5]);
    ctx.beginPath();
    ctx.moveTo(x, pad.t);
    ctx.lineTo(x, pad.t + plotH);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = s.side === 0 ? COLORS.mint : COLORS.blue;
    ctx.beginPath();
    ctx.arc(x, mid, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }

  // Trace.
  ctx.beginPath();
  started = false;
  for (let i = 0; i < n; i++) {
    if (t[i] < tStart) continue;
    const x = xOf(t[i]);
    const y = yOf(v[i]);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = COLORS.mint;
  ctx.lineWidth = 1.7;
  ctx.shadowColor = 'rgba(53, 227, 194, 0.35)';
  ctx.shadowBlur = 7;
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Axis labels.
  ctx.fillStyle = COLORS.text;
  ctx.font = FONT_SM;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(`−${Math.round(span)} s`, pad.l, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText('지금', w - pad.r, h - 3);

  if (opts.paused) {
    ctx.fillStyle = 'rgba(4, 8, 14, 0.58)';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = COLORS.textBright;
    ctx.font = '600 13px "Pretendard Variable", Pretendard, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('일시정지', w / 2, h / 2);
  }
}

/* ------------------------------------------------------------------ */
/* Tachogram                                                           */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{dt:number, side?:number, recovered?:boolean}[]} intervals
 */
export function drawTachogram(canvas, intervals = []) {
  if (!canvas) return;
  const { ctx, w, h } = prepare(canvas);
  const pad = { l: 28, r: 6, t: 12, b: 18 };
  const plotW = Math.max(1, w - pad.l - pad.r);
  const plotH = Math.max(1, h - pad.t - pad.b);
  const bottom = pad.t + plotH;

  if (!intervals || intervals.length < 2) {
    emptyState(ctx, w, h, '걸음 간격 데이터가 부족합니다', '2걸음 이상 측정하면 리듬이 표시됩니다');
    return;
  }

  const data = intervals.slice(-260);
  const dts = data.map((d) => d.dt);
  const sorted = [...dts].sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const max = Math.max(...dts) * 1.08;
  const yMax = Math.max(0.5, max);
  const mean = dts.reduce((a, b) => a + b, 0) / dts.length;

  // Horizontal guides.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (const frac of [0.25, 0.5, 0.75]) {
    const y = pad.t + plotH * frac;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  // Baseline.
  ctx.strokeStyle = COLORS.gridStrong;
  ctx.beginPath();
  ctx.moveTo(pad.l, bottom);
  ctx.lineTo(w - pad.r, bottom);
  ctx.stroke();

  const gap = data.length > 90 ? 0.6 : data.length > 40 ? 1.2 : 2.4;
  const barW = Math.max(1.6, plotW / data.length - gap);

  data.forEach((d, i) => {
    const x = pad.l + (i / Math.max(1, data.length - 1)) * (plotW - barW) + barW / 2;
    const bh = Math.max(2, (Math.min(d.dt, yMax) / yMax) * plotH);
    const y = bottom - bh;
    const color = d.side === 0 ? COLORS.mint : COLORS.blue;
    ctx.fillStyle = color;
    ctx.globalAlpha = d.recovered ? 0.55 : 0.78;
    roundRect(ctx, x - barW / 2, y, barW, bh, Math.min(3, barW / 2));
    ctx.fill();
    // A conspicuously long interval is usually a hesitation or a missed step.
    if (d.dt > med * 1.7) {
      ctx.globalAlpha = 1;
      ctx.fillStyle = COLORS.amber;
      ctx.beginPath();
      ctx.arc(x, y + 2, Math.min(2.6, barW / 2 + 0.5), 0, Math.PI * 2);
      ctx.fill();
    }
  });
  ctx.globalAlpha = 1;

  // Mean line.
  const yMean = bottom - (Math.min(mean, yMax) / yMax) * plotH;
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.32)';
  ctx.setLineDash([4, 4]);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad.l, yMean);
  ctx.lineTo(w - pad.r, yMean);
  ctx.stroke();
  ctx.setLineDash([]);

  // Y-axis labels.
  ctx.fillStyle = COLORS.text;
  ctx.font = FONT_SM;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(`${yMax.toFixed(1)}s`, pad.l - 6, pad.t + 3);
  ctx.fillText(`${(yMax / 2).toFixed(1)}`, pad.l - 6, pad.t + plotH / 2);
  ctx.fillText('0', pad.l - 6, bottom - 2);

  // X labels.
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText('첫 걸음', pad.l, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(`최근 ${data.length}걸음`, w - pad.r, h - 3);

  if (mean > 0) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(167, 182, 203, 0.9)';
    ctx.fillText(`평균 ${mean.toFixed(2)}초`, pad.l + plotW / 2, Math.max(pad.t + 9, yMean - 5));
  }
}

/* ------------------------------------------------------------------ */
/* Longitudinal trend                                                  */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{t:number, value:number}[]} points chronological
 * @param {{color?:string, unit?:string, decimals?:number}} opts
 */
export function drawTrend(canvas, points = [], opts = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prepare(canvas);
  const pad = { l: 34, r: 12, t: 16, b: 20 };
  const plotW = Math.max(1, w - pad.l - pad.r);
  const plotH = Math.max(1, h - pad.t - pad.b);
  const color = opts.color || COLORS.mint;
  const decimals = opts.decimals ?? 0;

  const data = points.filter((p) => Number.isFinite(p.value)).slice(-12);
  if (data.length < 2) {
    emptyState(ctx, w, h, '기록이 더 필요합니다', '2회 이상 측정하면 변화 추이가 표시됩니다');
    return;
  }

  const values = data.map((p) => p.value);
  let lo = Math.min(...values);
  let hi = Math.max(...values);
  if (hi - lo < 1e-6) { lo -= 1; hi += 1; }
  const padY = Math.max((hi - lo) * 0.22, 1);
  lo = Math.max(0, lo - padY);
  hi += padY;

  const xOf = (i) => pad.l + (i / (data.length - 1)) * plotW;
  const yOf = (v) => pad.t + plotH - ((v - lo) / (hi - lo)) * plotH;

  // Grid.
  ctx.strokeStyle = COLORS.grid;
  ctx.lineWidth = 1;
  for (const frac of [0, 0.5, 1]) {
    const y = pad.t + plotH * frac;
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
  }

  // Area.
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + plotH);
  grad.addColorStop(0, color === COLORS.blue ? 'rgba(127, 166, 255, 0.20)' : 'rgba(53, 227, 194, 0.20)');
  grad.addColorStop(1, color === COLORS.blue ? 'rgba(127, 166, 255, 0.01)' : 'rgba(53, 227, 194, 0.01)');
  ctx.beginPath();
  data.forEach((p, i) => {
    const x = xOf(i);
    const y = yOf(p.value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.lineTo(xOf(data.length - 1), pad.t + plotH);
  ctx.lineTo(xOf(0), pad.t + plotH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Line.
  ctx.beginPath();
  data.forEach((p, i) => {
    const x = xOf(i);
    const y = yOf(p.value);
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.stroke();

  // Points.
  data.forEach((p, i) => {
    const x = xOf(i);
    const y = yOf(p.value);
    const last = i === data.length - 1;
    if (last) {
      ctx.fillStyle = color;
      ctx.globalAlpha = 0.18;
      ctx.beginPath();
      ctx.arc(x, y, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.fillStyle = last ? color : '#0b131e';
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.7;
    ctx.beginPath();
    ctx.arc(x, y, last ? 4 : 3.1, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  });

  // Axis labels.
  ctx.fillStyle = COLORS.text;
  ctx.font = FONT_SM;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'right';
  ctx.fillText(hi.toFixed(decimals), pad.l - 7, pad.t + 4);
  ctx.fillText(lo.toFixed(decimals), pad.l - 7, pad.t + plotH - 4);
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.fillText(niceDate(data[0].t), pad.l, h - 3);
  ctx.textAlign = 'right';
  ctx.fillText(niceDate(data[data.length - 1].t), w - pad.r, h - 3);
}

/* ------------------------------------------------------------------ */
/* Bland–Altman                                                        */
/* ------------------------------------------------------------------ */

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{device:number[], manual:number[], diffs:number[], bias:number, loaUpper:number, loaLower:number, n:number}} ba
 */
export function drawBlandAltman(canvas, ba) {
  if (!canvas) return;
  const { ctx, w, h } = prepare(canvas);
  const pad = { l: 36, r: 64, t: 16, b: 24 };
  const plotW = Math.max(1, w - pad.l - pad.r);
  const plotH = Math.max(1, h - pad.t - pad.b);

  if (!ba || !ba.n) {
    emptyState(ctx, w, h, '비교 데이터가 없습니다', '관찰자 계수를 입력하면 일치도가 표시됩니다');
    return;
  }

  const means = ba.device.map((d, i) => (d + ba.manual[i]) / 2);
  let xLo = Math.min(...means);
  let xHi = Math.max(...means);
  if (xHi - xLo < 8) { xLo -= 4; xHi += 4; }
  const xPad = (xHi - xLo) * 0.08;
  xLo -= xPad; xHi += xPad;

  const yExtent = Math.max(
    2,
    Math.abs(ba.loaUpper || 0) * 1.25,
    Math.abs(ba.loaLower || 0) * 1.25,
    ...(ba.diffs || []).map((d) => Math.abs(d) * 1.2),
  );
  const yLo = -yExtent;
  const yHi = yExtent;

  const xOf = (v) => pad.l + ((v - xLo) / (xHi - xLo)) * plotW;
  const yOf = (v) => pad.t + plotH - ((v - yLo) / (yHi - yLo)) * plotH;

  // Lines: zero, bias, LoA.
  const lines = [
    { y: 0, color: COLORS.gridStrong, dash: [] },
    { y: ba.bias, color: COLORS.mint, dash: [5, 4] },
    { y: ba.loaUpper, color: COLORS.amber, dash: [3, 4] },
    { y: ba.loaLower, color: COLORS.amber, dash: [3, 4] },
  ];
  for (const line of lines) {
    if (!Number.isFinite(line.y)) continue;
    const y = yOf(line.y);
    if (y < pad.t - 1 || y > pad.t + plotH + 1) continue;
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.y === 0 ? 1 : 1.3;
    ctx.setLineDash(line.dash);
    ctx.beginPath();
    ctx.moveTo(pad.l, y);
    ctx.lineTo(w - pad.r, y);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Points.
  means.forEach((m, i) => {
    const x = xOf(m);
    const y = yOf(ba.diffs[i]);
    ctx.fillStyle = COLORS.blue;
    ctx.globalAlpha = 0.88;
    ctx.beginPath();
    ctx.arc(x, y, 4, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = 'rgba(127, 166, 255, 0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(x, y, 6.5, 0, Math.PI * 2);
    ctx.stroke();
  });

  // Labels for the bias / LoA, on the right.
  ctx.font = FONT_SM;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const label = (value, color, text) => {
    if (!Number.isFinite(value)) return;
    const y = yOf(value);
    if (y < pad.t || y > pad.t + plotH) return;
    ctx.fillStyle = color;
    ctx.fillText(text, w - pad.r + 7, y);
  };
  label(ba.bias, COLORS.mint, `평균 ${ba.bias >= 0 ? '+' : ''}${ba.bias.toFixed(1)}`);
  label(ba.loaUpper, COLORS.amber, `상한 ${ba.loaUpper >= 0 ? '+' : ''}${ba.loaUpper.toFixed(1)}`);
  label(ba.loaLower, COLORS.amber, `하한 ${ba.loaLower >= 0 ? '+' : ''}${ba.loaLower.toFixed(1)}`);

  // Axes.
  ctx.fillStyle = COLORS.text;
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.fillText(`+${yExtent.toFixed(0)}`, pad.l - 6, pad.t + 2);
  ctx.fillText('0', pad.l - 6, pad.t + plotH / 2);
  ctx.fillText(`−${yExtent.toFixed(0)}`, pad.l - 6, pad.t + plotH - 2);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillText('평균 걸음 수 (기기·관찰자)', pad.l, h - 4);
  ctx.textAlign = 'center';
  ctx.save();
  ctx.translate(10, pad.t + plotH / 2);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'middle';
  ctx.fillText('차이', 0, 0);
  ctx.restore();
}
