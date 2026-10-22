/**
 * StrideCare — agreement statistics
 * Used by the clinical validation view (manual count vs. device count).
 */

export function mean(a) {
  if (!a.length) return 0;
  return a.reduce((s, x) => s + x, 0) / a.length;
}

export function sd(a) {
  if (a.length < 2) return 0;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
}

export function median(a) {
  if (!a.length) return 0;
  const b = [...a].sort((x, y) => x - y);
  const m = b.length >> 1;
  return b.length % 2 ? b[m] : (b[m - 1] + b[m]) / 2;
}

/** Mean absolute error. */
export function mae(pred, ref) {
  if (!pred.length) return 0;
  return mean(pred.map((p, i) => Math.abs(p - ref[i])));
}

/** Mean absolute percentage error (%). */
export function mape(pred, ref) {
  if (!pred.length) return 0;
  const errs = pred.map((p, i) => (ref[i] ? Math.abs(p - ref[i]) / ref[i] : 0));
  return mean(errs) * 100;
}

/** Root mean squared error. */
export function rmse(pred, ref) {
  if (!pred.length) return 0;
  return Math.sqrt(mean(pred.map((p, i) => (p - ref[i]) ** 2)));
}

/**
 * Bland–Altman summary. Returns bias (device − manual), limits of agreement
 * (bias ± 1.96 SD) and the differences.
 */
export function blandAltman(device, manual) {
  const diffs = device.map((d, i) => d - manual[i]);
  const bias = mean(diffs);
  const s = sd(diffs);
  return {
    n: diffs.length,
    bias,
    sd: s,
    loaUpper: bias + 1.96 * s,
    loaLower: bias - 1.96 * s,
    diffs,
  };
}

/** ICC(2,1) — two-way random effects, absolute agreement, single rater. */
export function icc21(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 3) return null;
  const k = 2;
  const grand = mean([...x.slice(0, n), ...y.slice(0, n)]);

  let ssRows = 0;
  for (let i = 0; i < n; i++) {
    const rowMean = (x[i] + y[i]) / 2;
    ssRows += k * (rowMean - grand) ** 2;
  }

  const xm = mean(x.slice(0, n));
  const ym = mean(y.slice(0, n));
  const ssCols = n * ((xm - grand) ** 2 + (ym - grand) ** 2);

  let ssTotal = 0;
  for (let i = 0; i < n; i++) {
    ssTotal += (x[i] - grand) ** 2 + (y[i] - grand) ** 2;
  }

  const ssErr = ssTotal - ssRows - ssCols;
  const msRows = ssRows / (n - 1);
  const msCols = ssCols / (k - 1);
  const msErr = ssErr / ((k - 1) * (n - 1));

  const denom = msRows + (k - 1) * msErr + (k * (msCols - msErr)) / n;
  if (denom <= 0) return null;
  return (msRows - msErr) / denom;
}

/** Lin's concordance correlation coefficient. */
export function ccc(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  const sx = sd(x.slice(0, n));
  const sy = sd(y.slice(0, n));
  let sxy = 0;
  for (let i = 0; i < n; i++) sxy += (x[i] - mx) * (y[i] - my);
  sxy /= (n - 1);
  if (sx === 0 || sy === 0) return null;
  return (2 * sxy) / (sx ** 2 + sy ** 2 + (mx - my) ** 2);
}

/** Simple linear regression y = a + b x. */
export function linreg(x, y) {
  const n = Math.min(x.length, y.length);
  if (n < 2) return null;
  const mx = mean(x.slice(0, n));
  const my = mean(y.slice(0, n));
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (x[i] - mx) * (y[i] - my);
    den += (x[i] - mx) ** 2;
  }
  if (den === 0) return null;
  const b = num / den;
  return { slope: b, intercept: my - b * mx, r2: b === 0 ? 0 : (num * num) / (den * y.slice(0, n).reduce((s, v) => s + (v - my) ** 2, 0)) };
}

/** Bland–Altman consistency: % of points inside the limits of agreement. */
export function withinLoa(ba) {
  if (!ba.n) return 0;
  const inside = ba.diffs.filter((d) => d >= ba.loaLower && d <= ba.loaUpper).length;
  return (inside / ba.n) * 100;
}
