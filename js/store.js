/**
 * Local-first persistence. Nothing leaves the device.
 */

const KEY = 'stridecare.v1';

const DEFAULT_PROFILE = {
  name: '',
  side: 'none',
  aid: 'none',
  heightCm: '',
};

const DEFAULT_SETTINGS = {
  sensitivity: 'standard',
  sound: true,
  haptic: true,
  largeText: false,
  contrast: false,
  reduceMotion: false,
  wakeLock: true,
};

function defaults() {
  return {
    profile: { ...DEFAULT_PROFILE },
    settings: { ...DEFAULT_SETTINGS },
    sessions: [],
    calibration: null,
  };
}

let cache = null;

export function load() {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) { cache = defaults(); return cache; }
    const parsed = JSON.parse(raw);
    cache = {
      ...defaults(),
      ...parsed,
      profile: { ...DEFAULT_PROFILE, ...(parsed.profile || {}) },
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
      sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
    };
  } catch {
    cache = defaults();
  }
  return cache;
}

export function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch (e) {
    console.warn('저장 실패', e);
  }
}

export function getProfile() { return load().profile; }
export function setProfile(patch) {
  const s = load();
  s.profile = { ...s.profile, ...patch };
  save();
  return s.profile;
}

export function getSettings() { return load().settings; }
export function setSettings(patch) {
  const s = load();
  s.settings = { ...s.settings, ...patch };
  save();
  return s.settings;
}

export function getCalibration() { return load().calibration; }
export function setCalibration(cal) {
  const s = load();
  s.calibration = cal;
  save();
}

export function getSessions() {
  return load().sessions.slice().sort((a, b) => b.createdAt - a.createdAt);
}

export function getSession(id) {
  return load().sessions.find((s) => s.id === id) || null;
}

export function addSession(session) {
  const s = load();
  s.sessions.push(session);
  // Keep 500 most recent sessions.
  if (s.sessions.length > 500) s.sessions = s.sessions.slice(-500);
  save();
  return session;
}

export function updateSession(id, patch) {
  const s = load();
  const i = s.sessions.findIndex((x) => x.id === id);
  if (i < 0) return null;
  s.sessions[i] = { ...s.sessions[i], ...patch };
  save();
  return s.sessions[i];
}

export function deleteSession(id) {
  const s = load();
  s.sessions = s.sessions.filter((x) => x.id !== id);
  save();
}

export function clearAll() {
  const s = load();
  s.sessions = [];
  s.calibration = null;
  save();
}

export function hasManualCounts() {
  return getSessions().some((x) => Number.isFinite(x.manualCount) && x.manualCount > 0);
}

/* ------------------------------------------------------------------ */
/* CSV export                                                          */
/* ------------------------------------------------------------------ */

const CSV_COLUMNS = [
  ['createdAt', '측정시각'],
  ['patientName', '환자'],
  ['pareticSide', '마비측'],
  ['assistiveDevice', '보조기구'],
  ['protocolLabel', '프로토콜'],
  ['source', '측정모드'],
  ['durationSec', '시간(초)'],
  ['steps', '걸음수'],
  ['cadence', '케이던스(steps/min)'],
  ['asymmetry', '계단시간비대칭(%)'],
  ['intervalCV', '걸음변동계수(%)'],
  ['meanInterval', '평균걸음간격(초)'],
  ['gaitSpeed', '보행속도(m/s)'],
  ['stepLength', '보폭(m)'],
  ['quality', '품질점수'],
  ['qualityLabel', '품질등급'],
  ['demo', '데모데이터'],
  ['manualCount', '관찰자계수'],
  ['errorSteps', '오차(보)'],
  ['errorPct', '오차율(%)'],
  ['note', '메모'],
];

export function toCsv(sessions = getSessions()) {
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  const lines = [CSV_COLUMNS.map(([, label]) => label).join(',')];
  for (const s of sessions) {
    lines.push(CSV_COLUMNS.map(([key]) => {
      if (key === 'createdAt') return esc(new Date(s.createdAt).toISOString());
      if (key === 'errorPct') {
        if (!s.manualCount) return '';
        return esc((((s.steps - s.manualCount) / s.manualCount) * 100).toFixed(1));
      }
      if (key === 'errorSteps') {
        if (!s.manualCount) return '';
        return esc(s.steps - s.manualCount);
      }
      if (key === 'demo') return s.demo ? 'Y' : '';
      return esc(s[key]);
    }).join(','));
  }
  return '\ufeff' + lines.join('\r\n');
}

export function downloadCsv() {
  const csv = toCsv();
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  a.href = url;
  a.download = `stridecare_${stamp}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

/* ------------------------------------------------------------------ */
/* Demo data                                                           */
/* ------------------------------------------------------------------ */

export function seedDemoSessions() {
  // Deterministic, clearly-labelled demo records so the validation
  // dashboard can be inspected without a phone.
  const now = Date.now();
  const rows = [
    { days: 27, steps: 138, manual: 140, cadence: 66, asym: 24.5, cv: 8.1, q: 71, dur: 126, protocol: '2min' },
    { days: 24, steps: 142, manual: 141, cadence: 68, asym: 22.1, cv: 7.4, q: 76, dur: 125, protocol: '2min' },
    { days: 20, steps: 151, manual: 149, cadence: 71, asym: 21.0, cv: 7.0, q: 78, dur: 128, protocol: '2min' },
    { days: 16, steps: 158, manual: 158, cadence: 73, asym: 19.4, cv: 6.2, q: 82, dur: 130, protocol: '2min' },
    { days: 12, steps: 336, manual: 331, cadence: 70, asym: 18.2, cv: 6.8, q: 64, dur: 288, protocol: '6min' },
    { days: 8, steps: 163, manual: 161, cadence: 75, asym: 17.6, cv: 5.9, q: 85, dur: 130, protocol: '2min' },
    { days: 4, steps: 171, manual: 173, cadence: 77, asym: 16.2, cv: 5.4, q: 84, dur: 133, protocol: '2min' },
    { days: 1, steps: 178, manual: 177, cadence: 79, asym: 15.1, cv: 5.0, q: 88, dur: 135, protocol: '2min' },
  ];
  const s = load();
  s.sessions = s.sessions.filter((x) => !x.demo);
  for (const r of rows) {
    const created = now - r.days * 86400000;
    const T = 60 / r.cadence;
    const half = (r.asym / 100) / 2;
    const intervalDts = [];
    const intervalSides = [];
    let k = 0;
    while (intervalDts.length < Math.min(300, r.steps - 1)) {
      const side = k % 2;
      let dt = T * (side === 0 ? 1 + half : 1 - half);
      if ((k * 7 + r.days) % 37 === 0) dt += 0.22;
      intervalDts.push(Number(dt.toFixed(3)));
      intervalSides.push(side);
      k++;
    }
    s.sessions.push({
      id: `demo-${r.days}`,
      createdAt: created,
      patientName: '데모 환자',
      pareticSide: 'left',
      assistiveDevice: 'cane',
      protocol: r.protocol,
      protocolLabel: r.protocol === '6min' ? '6분 보행' : '2분 보행',
      source: 'demo',
      durationSec: r.dur,
      walkedSec: r.dur - 6,
      steps: r.steps,
      manualCount: r.manual,
      cadence: r.cadence,
      asymmetry: r.asym,
      asymmetrySigned: r.asym * 0.8,
      intervalCV: r.cv,
      meanInterval: 60 / r.cadence,
      intervalDts,
      intervalSides,
      sideA: intervalSides.filter((x) => x === 0).length,
      sideB: intervalSides.filter((x) => x === 1).length,
      quality: r.q,
      qualityLabel: r.q >= 75 ? '높음' : r.q >= 50 ? '보통' : '낮음',
      qualityReasons: [],
      gaitSpeed: r.protocol === '10m' ? 10 / r.dur : null,
      stepLength: null,
      demo: true,
      note: '데모 데이터',
    });
  }
  save();
  return s.sessions.length;
}
