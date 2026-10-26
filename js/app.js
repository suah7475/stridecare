/**
 * StrideCare — application shell
 *
 * Wires the measurement session, charts, local store and the screens.
 * Signal processing runs in the detector on a bounded 50 Hz window; this file
 * only schedules work and renders the result.
 */

import { SessionController, PROTOCOLS, resolveParams } from './session.js';
import {
  getProfile, setProfile, getSettings, setSettings,
  getCalibration, setCalibration, getSessions, getSession,
  addSession, updateSession, deleteSession, clearAll,
  downloadCsv, seedDemoSessions,
} from './store.js';
import { SENSITIVITY_PRESETS } from './core/detector.js';
import { drawLiveWave, drawTachogram, drawTrend, drawBlandAltman } from './charts.js';
import { calibrate } from './calibrate.js';
import { runBenchmark } from './benchmark.js';
import { mape, mae, blandAltman, icc21, ccc, withinLoa } from './core/stats.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const NF = new Intl.NumberFormat('ko-KR');
const WEEKDAYS = ['일', '월', '화', '수', '목', '금', '토'];

const SIDE_LABEL = { none: '마비측 미상', left: '좌측 마비', right: '우측 마비', bilateral: '양측' };
const AID_LABEL = { none: '보조기구 없음', cane: '지팡이', walker: '워커', orthosis: '보조기(AFO 등)' };
const qualityClass = (label) => (label === '높음' ? '' : label === '보통' ? 'is-warn' : 'is-low');

const ui = {
  // measure
  todayLabel: $('todayLabel'),
  psName: $('psName'), psMeta: $('psMeta'),
  profileStrip: $('profileStrip'), editProfile: $('editProfile'),
  protocolGroup: $('protocolGroup'), protocolHint: $('protocolHint'),
  startBtn: $('startBtn'), startMeta: $('startMeta'),
  measureCalibBtn: $('measureCalibBtn'), measureCalibBadge: $('measureCalibBadge'), measureCalibStatus: $('measureCalibStatus'),
  sensorChip: $('sensorChip'), quickSettings: $('quickSettings'),
  railPatient: $('railPatient'), recentBlock: $('recentBlock'), recentCard: $('recentCard'),
  // live
  screenLive: $('screen-live'),
  liveProtocol: $('liveProtocol'), liveSource: $('liveSource'),
  liveTimer: $('liveTimer'), liveSettingsBtn: $('liveSettingsBtn'),
  liveSteps: $('liveSteps'), liveCadence: $('liveCadence'),
  liveTarget: $('liveTarget'), liveQuality: $('liveQuality'),
  liveWave: $('liveWave'), waveHint: $('waveHint'), liveHz: $('liveHz'),
  balancePct: $('balancePct'), balanceA: $('balanceA'), balanceB: $('balanceB'),
  balanceLeft: $('balanceLeft'), balanceRight: $('balanceRight'),
  manualToggle: $('manualToggle'), manualBtn: $('manualBtn'), manualCount: $('manualCount'),
  soundToggle: $('soundToggle'), vibeToggle: $('vibeToggle'),
  pauseBtn: $('pauseBtn'), stopBtn: $('stopBtn'), liveNote: $('liveNote'),
  wavePanel: document.querySelector('.wave-panel'),
  liveSide: document.querySelector('.live-side'),
  countLabel: document.querySelector('.count-label'),
  countUnit: document.querySelector('.count-unit'),
  countValue: document.querySelector('.count-value'),
  // result
  resultBack: $('resultBack'), resultProtocol: $('resultProtocol'),
  resultDate: $('resultDate'), resultSteps: $('resultSteps'),
  resultQuality: $('resultQuality'), resultDuration: $('resultDuration'),
  resultRefined: $('resultRefined'), resultNote: $('resultNote'),
  mCadence: $('mCadence'), mAsym: $('mAsym'), mCV: $('mCV'),
  mSpeedKey: $('mSpeedKey'), mSpeed: $('mSpeed'), mSpeedUnit: $('mSpeedUnit'),
  tachogram: $('tachogram'), rhythmMeta: $('rhythmMeta'), rhythmHint: $('rhythmHint'),
  sideMeta: $('sideMeta'), sideA: $('sideA'), sideB: $('sideB'),
  sideCountA: $('sideCountA'), sideCountB: $('sideCountB'),
  mInterval: $('mInterval'), mAmp: $('mAmp'), sideHint: $('sideHint'),
  manualPanel: $('manualPanel'), manualInput: $('manualInput'),
  compareBtn: $('compareBtn'), compareResult: $('compareResult'),
  resultNoteInput: $('resultNoteInput'), discardBtn: $('discardBtn'), saveBtn: $('saveBtn'),
  // history
  exportBtn: $('exportBtn'), historyStats: $('historyStats'),
  trendCadence: $('trendCadence'), trendAsym: $('trendAsym'),
  sessionCount: $('sessionCount'), sessionList: $('sessionList'),
  // validation
  valCount: $('valCount'), valMape: $('valMape'), valSummary: $('valSummary'),
  valKpis: $('valKpis'), blandAltman: $('blandAltman'),
  calibBtn: $('calibBtn'), calibStatus: $('calibStatus'), calibReset: $('calibReset'),
  runBenchmark: $('runBenchmark'), benchResult: $('benchResult'),
  // settings
  setName: $('setName'), setSide: $('setSide'), setAid: $('setAid'), setHeight: $('setHeight'),
  saveProfile: $('saveProfile'), sensitivityGroup: $('sensitivityGroup'), sensitivityMeta: $('sensitivityMeta'),
  setLargeText: $('setLargeText'), setContrast: $('setContrast'), setMotion: $('setMotion'), setWake: $('setWake'),
  diagState: $('diagState'), diagAccel: $('diagAccel'), diagGyro: $('diagGyro'),
  diagRate: $('diagRate'), diagGravity: $('diagGravity'), diagBar: $('diagBar'), diagBtn: $('diagBtn'),
  exportBtn2: $('exportBtn2'), demoBtn: $('demoBtn'), clearBtn: $('clearBtn'),
  // modals
  modalStart: $('modalStart'), modalStartTitle: $('modalStartTitle'), modalStartBody: $('modalStartBody'),
  modalStartHint: $('modalStartHint'), useDemo: $('useDemo'), allowSensor: $('allowSensor'),
  modalConfirm: $('modalConfirm'), confirmTitle: $('confirmTitle'),
  confirmBody: $('confirmBody'), confirmStop: $('confirmStop'),
  modalCalib: $('modalCalib'), calibIntro: $('calibIntro'), calibRec: $('calibRec'),
  calibCount: $('calibCount'), calibCountLabel: $('calibCountLabel'),
  calibDuration: $('calibDuration'), calibDurationLabel: $('calibDurationLabel'),
  calibRun: $('calibRun'), calibHint: $('calibHint'), calibRedo: $('calibRedo'),
  toast: $('toast'),
};

const state = {
  controller: null,
  measuring: false,
  starting: false,
  selectedProtocol: 'free',
  live: null,
  current: null,
  resultReturn: 'measure',
  currentScreen: 'measure',
  calibRecording: null,
  calibBusy: false,
  calibOrigin: 'validation',
  benchmarkBusy: false,
  diagBusy: false,
  navBusy: false,
  confirmResolve: null,
  lastFocus: null,
  pulseTimer: null,
  toastTimer: null,
  resizeTimer: null,
  lastBeep: 0,
  audioCtx: null,
};

/* ------------------------------------------------------------------ */
/* Formatting                                                          */
/* ------------------------------------------------------------------ */

function fmtClock(sec) {
  const s = Math.max(0, Math.round(sec || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
}

function fmtNum(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return digits > 0 ? n.toFixed(digits) : NF.format(Math.round(n));
}

function fmtSigned(v, digits = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '—';
  return `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;
}

function dateText(ts) {
  const d = new Date(ts || Date.now());
  return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${WEEKDAYS[d.getDay()]}요일`;
}

function timeText(ts) {
  const d = new Date(ts || Date.now());
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function shortDate(ts) {
  const d = new Date(ts);
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`;
}

/* ------------------------------------------------------------------ */
/* Toast, modal, confirmation                                          */
/* ------------------------------------------------------------------ */

function toast(text, kind = '') {
  clearTimeout(state.toastTimer);
  ui.toast.textContent = text;
  ui.toast.className = `toast${kind === 'error' ? ' is-error' : ''}`;
  requestAnimationFrame(() => ui.toast.classList.add('is-visible'));
  state.toastTimer = setTimeout(() => {
    ui.toast.classList.remove('is-visible');
  }, 3600);
}

function modalOpen(modal) {
  state.lastFocus = document.activeElement;
  modal.hidden = false;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => {
    const target = modal.querySelector('input:not([disabled]), select:not([disabled]), button:not([data-close])');
    target?.focus({ preventScroll: true });
  });
}

function anyModalOpen() {
  return !ui.modalStart.hidden || !ui.modalConfirm.hidden || !ui.modalCalib.hidden;
}

function modalClose(modal) {
  modal.hidden = true;
  if (!anyModalOpen()) document.body.style.overflow = '';
  state.lastFocus?.focus?.({ preventScroll: true });
}

function settleConfirm(value) {
  const resolve = state.confirmResolve;
  state.confirmResolve = null;
  ui.modalConfirm.hidden = true;
  if (!anyModalOpen()) document.body.style.overflow = '';
  resolve?.(value);
}

function askConfirm({ title, body, confirm = '확인', danger = false }) {
  if (state.confirmResolve) settleConfirm(false);
  ui.confirmTitle.textContent = title;
  ui.confirmBody.textContent = body;
  ui.confirmStop.textContent = confirm;
  ui.confirmStop.className = `btn ${danger ? 'btn--danger' : 'btn--primary'}`;
  modalOpen(ui.modalConfirm);
  return new Promise((resolve) => {
    state.confirmResolve = resolve;
  });
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function setSensorChip(text, kind = 'idle') {
  ui.sensorChip.className = 'sensor-chip';
  if (kind !== 'idle') ui.sensorChip.classList.add(`is-${kind}`);
  ui.sensorChip.innerHTML = `<span class="dot"></span> ${text}`;
}

function sensorReadyChip() {
  const supported = SessionController.sensorAvailable();
  setSensorChip(supported ? '센서 준비됨' : '데모 전용', supported ? 'live' : 'warn');
  return supported;
}

function profileSummary() {
  const p = getProfile();
  const bits = [SIDE_LABEL[p.side] || SIDE_LABEL.none, AID_LABEL[p.aid] || AID_LABEL.none];
  if (p.heightCm) bits.push(`${p.heightCm} cm`);
  return bits.join(' · ');
}

function applyProfile() {
  const p = getProfile();
  const name = (p.name || '').trim();
  const initial = name ? Array.from(name)[0] : '환';
  const meta = name ? profileSummary() : '설정에서 환자 정보를 입력하세요';
  $$('.avatar').forEach((el) => { el.textContent = initial; });
  ui.psName.textContent = name || '환자 미등록';
  ui.psMeta.textContent = meta;
  const railStrong = ui.railPatient.querySelector('strong');
  const railSmall = ui.railPatient.querySelector('small');
  if (railStrong) railStrong.textContent = name || '환자 미등록';
  if (railSmall) railSmall.textContent = name ? meta : '설정에서 추가';
  ui.todayLabel.textContent = `${new Date().getMonth() + 1}월 ${new Date().getDate()}일 ${WEEKDAYS[new Date().getDay()]}요일 · 오늘의 측정`;
  updateStartMeta();
}

function updateStartMeta() {
  if (state.measuring) {
    ui.startMeta.textContent = '측정 중';
    return;
  }
  ui.startMeta.textContent = SessionController.sensorAvailable()
    ? '탭하여 센서 연결'
    : '탭하여 데모 체험';
}

function applyDisplaySettings() {
  const s = getSettings();
  document.body.classList.toggle('large-text', !!s.largeText);
  document.body.classList.toggle('high-contrast', !!s.contrast);
  document.body.classList.toggle('reduce-motion', !!s.reduceMotion);
}

function ensureAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!state.audioCtx) state.audioCtx = new AC();
    if (state.audioCtx.state === 'suspended') state.audioCtx.resume();
  } catch { /* audio is optional */ }
}

function stepFeedback() {
  if (!state.live || state.live.calib) return;
  const now = performance.now();
  if (state.live.sound && state.audioCtx && now - state.lastBeep > 90) {
    state.lastBeep = now;
    try {
      const ctx = state.audioCtx;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 660;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.035, ctx.currentTime + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + 0.06);
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.07);
    } catch { /* ignore */ }
  }
  if (state.live.haptic && navigator.vibrate) {
    try { navigator.vibrate(12); } catch { /* ignore */ }
  }
}

/* ------------------------------------------------------------------ */
/* Navigation                                                          */
/* ------------------------------------------------------------------ */

function showScreen(name, opts = {}) {
  state.currentScreen = name;
  $$('.screen').forEach((s) => s.classList.toggle('is-active', s.id === `screen-${name}`));
  document.body.classList.toggle('is-live', name === 'live');

  const navName = opts.nav || (name === 'result'
    ? (state.current?.stored ? 'history' : 'measure')
    : name);
  $$('.nav-item, .tab').forEach((b) => b.classList.toggle('is-active', b.dataset.nav === navName));

  window.scrollTo({ top: 0, behavior: 'auto' });
  if (name === 'history') renderHistory();
  if (name === 'validation') renderValidation();
  if (name === 'settings') hydrateSettings();
  if (name === 'measure') { renderRecent(); updateStartMeta(); }
}

async function navigate(name, opts = {}) {
  if (state.navBusy) return;
  if (name === 'live') return;
  if (state.measuring) {
    toast('측정 중에는 화면을 이동할 수 없습니다.');
    showScreen('live');
    return;
  }
  if (state.current && !state.current.stored && !state.current.savedId && state.currentScreen === 'result') {
    state.navBusy = true;
    const ok = await askConfirm({
      title: '저장하지 않고 이동할까요?',
      body: '이번 측정 결과가 저장되지 않고 사라집니다. 기록으로 남기려면 먼저 저장하세요.',
      confirm: '이동',
      danger: true,
    });
    state.navBusy = false;
    if (!ok) return;
    state.current = null;
  }
  showScreen(name, opts);
}

/* ------------------------------------------------------------------ */
/* Profile / protocols                                                 */
/* ------------------------------------------------------------------ */

function selectProtocol(key) {
  if (!PROTOCOLS[key]) return;
  state.selectedProtocol = key;
  $$('#protocolGroup .seg').forEach((b) => {
    const on = b.dataset.protocol === key;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-checked', on ? 'true' : 'false');
  });
  ui.protocolHint.textContent = PROTOCOLS[key].hint;
  updateStartMeta();
}

function chooseDemoProfile() {
  const p = getProfile();
  if (p.aid === 'cane' || p.aid === 'walker') return 'cane';
  if (p.side === 'bilateral') return 'shuffle';
  return 'hemiparetic';
}

function openStartModal() {
  const supported = SessionController.sensorAvailable();
  ui.modalStartTitle.textContent = supported ? '센서 연결' : '데모 모드';
  ui.modalStartBody.textContent = supported
    ? '스마트폰의 동작 센서를 사용합니다. 버튼을 누르면 권한을 요청합니다. 측정 중에는 허리 벨트에 단단히 고정하세요.'
    : '이 브라우저에서는 동작 센서를 사용할 수 없습니다. 합성 보행 신호로 측정부터 저장·검증까지 전체 흐름을 체험할 수 있습니다.';
  ui.modalStartHint.textContent = supported
    ? 'iPhone은 Safari, Android는 Chrome에서 가장 안정적으로 동작합니다. 권한을 허용해 주세요.'
    : '데모 데이터는 실제 환자 기록과 구분되도록 DEMO로 표시됩니다.';
  ui.useDemo.textContent = supported ? '데모로 체험' : '데모로 시작';
  ui.allowSensor.hidden = !supported;
  modalOpen(ui.modalStart);
}

// MODULE_CONTINUE_1

/* ------------------------------------------------------------------ */
/* Measurement session                                                 */
/* ------------------------------------------------------------------ */

function targetText(protocol, elapsed) {
  if (protocol.key === '10m') return '10 m';
  if (protocol.target) return fmtClock(Math.max(0, protocol.target - elapsed));
  return '—';
}

function resetLiveUI(protocol, mode, calibration) {
  state.live.protocol = protocol;
  ui.screenLive.classList.toggle('is-calib', calibration);
  ui.wavePanel.hidden = calibration;
  ui.liveSide.hidden = calibration;

  ui.countLabel.textContent = calibration ? '보정 녹음 · 남은 시간' : '걸음 수';
  ui.countUnit.textContent = calibration ? '초' : '보';
  ui.liveSteps.textContent = calibration ? String(Math.ceil(protocol.target || 0)) : '0';
  ui.countValue.classList.remove('is-step');

  ui.liveProtocol.textContent = calibration ? '개인 보정' : protocol.label;
  ui.liveSource.textContent = mode === 'demo' ? '데모' : (calibration ? '보정 녹음' : '센서');
  ui.liveTimer.textContent = '00:00';
  ui.liveCadence.textContent = calibration ? '—' : '0';
  ui.liveTarget.textContent = calibration ? fmtClock(protocol.target || 0) : targetText(protocol, 0);
  ui.liveQuality.textContent = '—';
  ui.waveHint.textContent = '보행을 시작하면 파형이 나타납니다';
  ui.liveHz.textContent = mode === 'demo' ? '50 Hz · 합성' : '— Hz';

  ui.balancePct.textContent = '—';
  ui.balanceA.style.width = '50%';
  ui.balanceB.style.width = '50%';
  ui.balanceLeft.textContent = 'A 0';
  ui.balanceRight.textContent = 'B 0';

  ui.manualToggle.checked = false;
  ui.manualBtn.disabled = true;
  ui.manualCount.textContent = '0';
  ui.soundToggle.checked = !!state.live.sound;
  ui.vibeToggle.checked = !!state.live.haptic;

  setPauseButton(false);
  ui.liveNote.textContent = calibration
    ? '관찰자는 앱의 걸음 수를 보지 말고 직접 세어 주세요. 녹음이 끝나면 계수를 입력합니다.'
    : '화면이 꺼지지 않도록 유지됩니다.';
  drawLiveWave(ui.liveWave, null, [], {});
}

function setPauseButton(paused) {
  const label = ui.pauseBtn.querySelector('span');
  const use = ui.pauseBtn.querySelector('use');
  if (label) label.textContent = paused ? '계속 측정' : '일시정지';
  if (use) use.setAttribute('href', paused ? '#i-play' : '#i-pause');
}

async function startSession(mode, opts = {}) {
  if (state.measuring || state.starting) return;
  state.starting = true;
  ensureAudio();

  const settings = getSettings();
  const storedCalibration = getCalibration();
  const calibration = opts.calibration
    ? null
    : (mode === 'sensor' && storedCalibration?.source === 'demo' ? null : storedCalibration);
  const params = resolveParams(settings, calibration);
  const protocolKey = opts.protocolKey || state.selectedProtocol;
  const protocol = opts.protocol || PROTOCOLS[protocolKey] || PROTOCOLS.free;
  const isCalib = !!opts.calibration;

  state.current = null;
  state.live = {
    manual: 0,
    paused: false,
    calib: isCalib,
    sound: isCalib ? false : !!settings.sound,
    haptic: isCalib ? false : !!settings.haptic,
    protocol,
    mode,
    lastCount: 0,
    lastSnap: null,
    stalledWarned: false,
    startedAt: Date.now(),
  };
  state.measuring = true;
  resetLiveUI(protocol, mode, isCalib);
  setSensorChip(mode === 'demo' ? '데모 재생 중' : (isCalib ? '보정 녹음 중' : '측정 중'), mode === 'demo' ? 'demo' : 'live');
  showScreen('live');

  const controller = new SessionController({
    onTick: handleTick,
    onStep: handleStep,
    onEnd: handleEnd,
    onStatus: handleStatus,
  });
  state.controller = controller;

  try {
    await controller.start({
      mode,
      protocolKey,
      protocol,
      params,
      demoProfile: opts.demoProfile || chooseDemoProfile(),
      wakeLock: !!settings.wakeLock,
    });
  } catch (error) {
    console.error(error);
    state.measuring = false;
    state.controller = null;
    state.starting = false;
    sensorReadyChip();
    showScreen('measure');
    toast(error?.message || '측정을 시작할 수 없습니다.', 'error');
    if (isCalib) openCalibModal();
    return;
  }
  state.starting = false;
}

function handleTick(snap) {
  if (!state.live) return;
  state.live.lastSnap = snap;
  const elapsed = snap.elapsed;
  ui.liveTimer.textContent = fmtClock(elapsed);

  if (state.live.calib) {
    const remain = Math.max(0, (snap.target || 0) - elapsed);
    ui.liveSteps.textContent = String(Math.ceil(remain));
    ui.liveCadence.textContent = '—';
    ui.liveTarget.textContent = `${fmtClock(elapsed)} 경과`;
    ui.liveQuality.textContent = '—';
  } else {
    if (snap.steps !== state.live.lastCount) {
      state.live.lastCount = snap.steps;
      ui.liveSteps.textContent = String(snap.steps);
      ui.countValue.classList.remove('is-step');
      void ui.countValue.offsetWidth;
      ui.countValue.classList.add('is-step');
      clearTimeout(state.pulseTimer);
      state.pulseTimer = setTimeout(() => ui.countValue.classList.remove('is-step'), 320);
    }
    ui.liveCadence.textContent = String(Math.round(snap.cadence || 0));
    ui.liveTarget.textContent = targetText(state.live.protocol, elapsed);
    ui.liveQuality.textContent = snap.quality ? String(Math.round(snap.quality.score)) : '—';
  }

  const total = (snap.sideA || 0) + (snap.sideB || 0);
  let pa = 50;
  if (total > 0) pa = Math.round((snap.sideA / total) * 100);
  ui.balancePct.textContent = total > 0 ? `${pa} : ${100 - pa}` : '—';
  ui.balanceA.style.width = `${pa}%`;
  ui.balanceB.style.width = `${100 - pa}%`;
  ui.balanceLeft.textContent = `A ${snap.sideA || 0}`;
  ui.balanceRight.textContent = `B ${snap.sideB || 0}`;

  if (!state.live.calib) {
    drawLiveWave(ui.liveWave, {
      t: snap.recent.t,
      v: snap.recent.v,
      duration: snap.recent.duration,
    }, snap.stepTimes, { paused: state.live.paused });
    if (!snap.steps) {
      ui.waveHint.textContent = '보행을 시작하면 파형이 나타납니다';
    } else if (snap.quality && snap.quality.score < 50) {
      ui.waveHint.textContent = '신호가 약합니다 · 벨트 착용과 자세를 확인하세요';
    } else {
      ui.waveHint.textContent = `${snap.steps}보 감지 · 수직 피크가 발 접지입니다`;
    }
    ui.liveHz.textContent = snap.mode === 'demo' ? '50 Hz · 합성' : `${snap.eventRate || 0} Hz 원신호`;
  }

  if (!state.live.calib && snap.mode === 'sensor' && elapsed > 6 && !snap.eventRate && !state.live.stalledWarned) {
    state.live.stalledWarned = true;
    setSensorChip('센서 응답 없음', 'warn');
    ui.liveNote.textContent = '가속도 이벤트가 없습니다. 권한과 센서를 확인하거나 데모로 전환하세요.';
    toast('센서 신호가 들어오지 않습니다. 권한을 확인해 주세요.', 'error');
  }
}

function handleStep() {
  if (!state.measuring) return;
  stepFeedback();
}

function handleStatus({ text, kind }) {
  if (!state.measuring) return;
  if (kind === 'demo') setSensorChip('데모 재생 중', 'demo');
  else if (kind === 'live') {
    setSensorChip(state.live?.calib ? '보정 녹음 중' : '측정 중', 'live');
    ui.liveNote.textContent = state.live?.calib
      ? '관찰자는 앱의 걸음 수를 보지 말고 직접 세어 주세요. 녹음이 끝나면 계수를 입력합니다.'
      : '화면이 꺼지지 않도록 유지됩니다.';
  } else if (kind === 'warn') setSensorChip('센서 주의', 'warn');
  else if (kind === 'idle') setSensorChip('측정 완료', 'idle');
  if (kind === 'warn') {
    ui.liveNote.textContent = text;
    toast(text, 'error');
  }
}

function pauseSession(silent = false) {
  if (!state.controller || !state.measuring || state.live?.paused) return;
  state.live.paused = true;
  state.controller.pause();
  setPauseButton(true);
  ui.manualBtn.disabled = true;
  setSensorChip('일시정지', 'warn');
  ui.liveNote.textContent = state.live.calib
    ? '보정 녹음이 일시정지되었습니다. 재개하면 같은 녹음에 이어서 기록합니다.'
    : '일시정지됨 — 재개하면 이어서 측정합니다.';
  if (!silent) toast('일시정지했습니다.');
}

function resumeSession(silent = false) {
  if (!state.controller || !state.measuring || !state.live?.paused) return;
  state.live.paused = false;
  state.controller.resume();
  setPauseButton(false);
  ui.manualBtn.disabled = !ui.manualToggle.checked;
  setSensorChip(state.live.mode === 'demo' ? '데모 재생 중' : '측정 중', state.live.mode === 'demo' ? 'demo' : 'live');
  ui.liveNote.textContent = state.live.calib
    ? '관찰자는 앱의 걸음 수를 보지 말고 직접 세어 주세요. 녹음이 끝나면 계수를 입력합니다.'
    : '화면이 꺼지지 않도록 유지됩니다.';
  if (!silent) toast('측정을 재개했습니다.');
}

async function requestStop() {
  if (!state.controller || !state.measuring) return;
  const wasPaused = !!state.live.paused;
  if (!wasPaused) pauseSession(true);
  const count = state.live.calib ? null : state.live.lastCount;
  const ok = await askConfirm({
    title: state.live.calib ? '보정 녹음을 종료할까요?' : '측정을 종료할까요?',
    body: state.live.calib
      ? '종료 후 관찰자가 센 걸음 수를 입력하면 보정 계산을 시작합니다.'
      : `지금까지 ${count}보를 기록했습니다. 종료하면 정밀 보정 후 결과를 계산합니다.`,
    confirm: '종료',
    danger: true,
  });
  if (ok) {
    state.controller?.stop('manual');
  } else if (!wasPaused) {
    resumeSession(true);
  }
}

function handleEnd(result) {
  const wasCalib = !!state.live?.calib;
  state.measuring = false;
  state.controller = null;
  state.live.paused = false;
  document.body.style.overflow = '';

  if (wasCalib) {
    state.calibRecording = {
      raw: result.raw,
      durationSec: result.durationSec,
      steps: result.steps,
      truthSteps: result.demoTruthSteps,
      mode: result.mode,
      createdAt: Date.now(),
    };
    state.current = null;
    sensorReadyChip();
    showScreen(state.calibOrigin === 'measure' ? 'measure' : 'validation');
    openCalibModal();
    toast('보정 녹음이 끝났습니다. 관찰자 계수를 입력하세요.');
    return;
  }

  const manual = state.live.manual > 0 ? state.live.manual : null;
  state.current = {
    res: result,
    stored: false,
    storedSession: null,
    savedId: null,
    manual,
    note: '',
    createdAt: Date.now(),
  };
  state.resultReturn = 'measure';
  sensorReadyChip();
  showScreen('result', { nav: 'measure' });
  renderResult(state.current);

  if (result.stoppedBy === 'auto') toast('목표 시간이 완료되어 자동으로 종료했습니다.');
  if (!result.ok) toast('걸음을 충분히 검출하지 못했습니다. 착용 위치를 확인하고 다시 측정하세요.', 'error');
}

function togglePause() {
  if (!state.measuring) return;
  if (state.live.paused) resumeSession();
  else pauseSession();
}

// MODULE_CONTINUE_2

/* ------------------------------------------------------------------ */
/* Result screen                                                       */
/* ------------------------------------------------------------------ */

function resultFromSession(s) {
  const dts = Array.isArray(s.intervalDts) ? s.intervalDts : [];
  const ss = Array.isArray(s.intervalSides) ? s.intervalSides : [];
  let acc = 0;
  const intervals = dts.map((dt, i) => {
    acc += Number(dt) || 0;
    return { dt: Number(dt) || 0, side: ss[i] ?? i % 2, t: acc };
  });
  const sideA = Number.isFinite(s.sideA)
    ? s.sideA
    : intervals.filter((x) => x.side === 0).length;
  const sideB = Number.isFinite(s.sideB)
    ? s.sideB
    : intervals.filter((x) => x.side === 1).length;
  const protocol = PROTOCOLS[s.protocol] || { key: s.protocol, label: s.protocolLabel || '보행' };
  return {
    ok: s.steps >= 2,
    protocol: { ...protocol, label: s.protocolLabel || protocol.label },
    mode: s.source || 'sensor',
    stoppedBy: 'stored',
    durationSec: s.durationSec || 0,
    walkedSec: s.walkedSec || dts.reduce((a, b) => a + b, 0),
    steps: s.steps,
    cadence: s.cadence,
    asymmetry: s.asymmetry,
    asymmetrySigned: s.asymmetrySigned,
    asymmetrySource: s.intervalSides ? 'rotation' : 'unknown',
    intervalCV: s.intervalCV,
    meanInterval: s.meanInterval,
    meanAmplitude: s.meanAmplitude ?? null,
    quality: s.quality || 0,
    qualityLabel: s.qualityLabel || '—',
    qualityReasons: Array.isArray(s.qualityReasons) ? s.qualityReasons : [],
    sideA,
    sideB,
    intervals,
    liveSteps: s.steps,
    createdAt: s.createdAt,
    heightCm: s.heightCm,
  };
}

function resultSummaryText(res) {
  const parts = [];
  if (res.mode === 'demo') parts.push('데모 신호로 계산한 결과입니다.');
  if (!res.ok) parts.push('검출된 걸음이 너무 적어 해석이 어렵습니다.');
  const label = res.qualityLabel || '—';
  const score = Number.isFinite(res.quality) ? Math.round(res.quality) : '—';
  parts.push(`신호 품질 ${label} (${score}/100).`);
  const reasons = [...new Set(res.qualityReasons || [])].slice(0, 2);
  if (reasons.length) parts.push(reasons.join(' · '));
  return parts.join(' ');
}

function speedInfo(res) {
  const height = Number(res.heightCm)
    || Number(state.current?.storedSession?.heightCm)
    || Number(getProfile().heightCm)
    || 0;
  if (res.protocol?.key === '10m' && res.durationSec > 0) {
    return { value: 10 / res.durationSec, key: '보행 속도', unit: 'm/s', title: '10 m 구간 시간 기준' };
  }
  if (height >= 100 && height <= 220 && res.walkedSec > 0 && res.steps > 1) {
    const stepLength = (height * 0.0041);
    return {
      value: (stepLength * (res.steps - 1)) / res.walkedSec,
      key: '보행 속도(추정)',
      unit: 'm/s',
      title: '키 기반 보폭 추정치입니다. 10 m 보행으로 측정하면 더 정확합니다.',
    };
  }
  return { value: null, key: '보행 속도', unit: 'm/s', title: '키를 입력하면 추정 속도를 계산합니다.' };
}

function renderResult(view) {
  const res = view.res;
  const ts = res.createdAt || view.createdAt || Date.now();
  const stored = !!view.stored;

  ui.resultProtocol.textContent = res.protocol?.label || '보행';
  ui.resultDate.textContent = `${dateText(ts)} · ${timeText(ts)}`;
  ui.resultSteps.textContent = NF.format(res.steps || 0);
  ui.resultQuality.textContent = `품질 ${res.qualityLabel || '—'} · ${fmtNum(res.quality)}`;
  ui.resultQuality.className = `badge ${qualityClass(res.qualityLabel)}`.trim();
  ui.resultDuration.textContent = `총 ${fmtClock(res.durationSec)}`;
  ui.resultNote.textContent = resultSummaryText(res);

  const diff = res.steps - (res.liveSteps ?? res.steps);
  if (!stored && Number.isFinite(diff) && diff !== 0) {
    ui.resultRefined.hidden = false;
    ui.resultRefined.textContent = `정밀 보정 ${fmtSigned(diff)}보`;
  } else {
    ui.resultRefined.hidden = true;
  }

  ui.mCadence.textContent = fmtNum(res.cadence);
  ui.mAsym.textContent = Number.isFinite(res.asymmetry) ? Number(res.asymmetry).toFixed(1) : '—';
  ui.mCV.textContent = Number.isFinite(res.intervalCV) ? Number(res.intervalCV).toFixed(1) : '—';
  const speed = speedInfo(res);
  ui.mSpeedKey.textContent = speed.key;
  ui.mSpeed.textContent = speed.value == null ? '—' : speed.value.toFixed(2);
  ui.mSpeedUnit.textContent = speed.unit;
  ui.mSpeed.title = speed.title;
  ui.mSpeedKey.title = speed.title;

  const intervalCount = res.intervals?.length || 0;
  ui.rhythmMeta.textContent = `${intervalCount}개 간격 · CV ${Number.isFinite(res.intervalCV) ? res.intervalCV.toFixed(1) : '—'}%`;
  ui.rhythmHint.textContent = res.asymmetry > 20
    ? '좌우 걸음 간격 차이가 큽니다. 편마비 보행에서 흔한 비대칭 패턴입니다.'
    : res.intervalCV > 18
      ? '걸음 간격 변동이 큽니다. 정지·출발이나 피로의 영향을 확인하세요.'
      : '각 막대는 한 걸음의 시간 간격입니다. 막대가 번갈아 길고 짧으면 좌우 비대칭을 뜻합니다.';
  drawTachogram(ui.tachogram, res.intervals || []);

  const sideTotal = (res.sideA || 0) + (res.sideB || 0);
  const pa = sideTotal > 0 ? Math.round((res.sideA / sideTotal) * 100) : 50;
  ui.sideA.style.width = `${pa}%`;
  ui.sideB.style.width = `${100 - pa}%`;
  ui.sideCountA.textContent = `A ${res.sideA || 0}`;
  ui.sideCountB.textContent = `B ${res.sideB || 0}`;
  const sideSource = res.asymmetrySource === 'rotation'
    ? '회전 기반'
    : res.asymmetrySource === 'parity'
      ? '교대 순서 기반'
      : '저장된 요약';
  ui.sideMeta.textContent = `${sideSource} · A ${pa}%`;
  ui.sideHint.textContent = res.asymmetrySource === 'rotation'
    ? '회전 신호로 좌우를 구분했습니다. A/B는 착용 방향에 따라 실제 좌/우와 바뀔 수 있습니다.'
    : res.asymmetrySource === 'parity'
      ? '회전 신호가 약해 걸음 순서로 A/B를 나눴습니다. 좌우 해석에 주의하세요.'
      : '저장된 기록에는 좌우 판정 근거가 요약되어 있습니다.';
  ui.mInterval.textContent = Number.isFinite(res.meanInterval) ? `${res.meanInterval.toFixed(2)} s` : '—';
  ui.mAmp.textContent = Number.isFinite(res.meanAmplitude) ? `${res.meanAmplitude.toFixed(2)}` : '—';

  ui.manualInput.value = view.manual > 0 ? String(view.manual) : '';
  ui.compareResult.hidden = true;
  ui.compareResult.className = 'compare-result';
  ui.resultNoteInput.value = view.note || '';

  const canSave = res.steps > 0;
  ui.saveBtn.disabled = !canSave && !view.savedId && !stored;
  if (stored) {
    ui.discardBtn.hidden = false;
    ui.discardBtn.textContent = '삭제';
    ui.saveBtn.textContent = '변경 저장';
  } else if (view.savedId) {
    ui.discardBtn.hidden = false;
    ui.discardBtn.textContent = '삭제';
    ui.saveBtn.textContent = '변경 저장';
  } else {
    ui.discardBtn.hidden = false;
    ui.discardBtn.textContent = '삭제';
    ui.saveBtn.textContent = '기록 저장';
  }

  if (view.manual > 0) compareManual({ persist: false, silent: true });
}

// MODULE_CONTINUE_3

/* ------------------------------------------------------------------ */
/* Comparison, persistence and deletion                                */
/* ------------------------------------------------------------------ */

function readManualInput() {
  const raw = ui.manualInput.value.trim();
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 9999) {
    toast('관찰자 계수는 0–9999 사이의 정수로 입력하세요.', 'error');
    return undefined;
  }
  return n > 0 ? n : null;
}

function compareManual({ persist = true, silent = false } = {}) {
  if (!state.current) return;
  const res = state.current.res;
  const n = readManualInput();
  if (n === undefined) return;
  if (n == null) {
    ui.compareResult.hidden = true;
    if (!silent) toast('관찰자 계수를 입력하세요.', 'error');
    return;
  }
  const diff = res.steps - n;
  const pct = n > 0 ? (diff / n) * 100 : 0;
  const abs = Math.abs(pct);
  ui.compareResult.hidden = false;
  ui.compareResult.className = `compare-result ${abs <= 3 ? 'is-good' : abs <= 10 ? 'is-warn' : 'is-bad'}`;
  ui.compareResult.innerHTML = `
    <div><strong>${fmtSigned(diff)}보</strong> · ${fmtSigned(pct, 1)}%</div>
    <div class="hint" style="margin-top:5px">기기 ${NF.format(res.steps)}보 · 관찰자 ${NF.format(n)}보 · ${
      abs <= 3 ? '일치도가 높습니다' : abs <= 10 ? '임상적으로 참고할 만한 차이입니다' : '차이가 큽니다. 보정을 고려하세요'
    }</div>`;
  state.current.manual = n;

  if (persist && (state.current.savedId || state.current.stored)) {
    const id = state.current.savedId || state.current.storedSession?.id;
    const updated = updateSession(id, { manualCount: n });
    if (updated) {
      state.current.storedSession = updated;
      if (state.current.stored) state.current.res = resultFromSession(updated);
      refreshAfterDataChange();
      if (!silent) toast('관찰자 계수를 검증 대시보드에 반영했습니다.');
    }
  } else if (!silent) {
    toast('비교했습니다. 기록을 저장하면 검증 대시보드에 포함됩니다.');
  }
}

function buildRecord(res, manual, note) {
  const p = getProfile();
  const height = Number(p.heightCm) || null;
  let stepLength = null;
  let gaitSpeed = null;
  if (res.protocol?.key === '10m' && res.durationSec > 0) {
    gaitSpeed = 10 / res.durationSec;
    stepLength = 10 / Math.max(1, res.steps);
  } else if (height && res.walkedSec > 0 && res.steps > 1) {
    stepLength = height * 0.0041;
    gaitSpeed = (stepLength * (res.steps - 1)) / res.walkedSec;
  }
  const intervals = (res.intervals || []).slice(-400);
  return {
    id: `s-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    createdAt: Date.now(),
    patientName: (p.name || '').trim(),
    pareticSide: p.side,
    assistiveDevice: p.aid,
    heightCm: height || '',
    protocol: res.protocol?.key || 'free',
    protocolLabel: res.protocol?.label || '자유 보행',
    source: res.mode || 'sensor',
    durationSec: Math.round(res.durationSec * 10) / 10,
    walkedSec: Math.round(res.walkedSec * 10) / 10,
    steps: res.steps,
    manualCount: manual,
    cadence: Math.round(res.cadence * 10) / 10,
    asymmetry: Math.round(res.asymmetry * 10) / 10,
    asymmetrySigned: Math.round(res.asymmetrySigned * 10) / 10,
    intervalCV: Math.round(res.intervalCV * 10) / 10,
    meanInterval: Math.round(res.meanInterval * 1000) / 1000,
    meanAmplitude: Number.isFinite(res.meanAmplitude) ? Math.round(res.meanAmplitude * 1000) / 1000 : null,
    quality: Math.round(res.quality * 10) / 10,
    qualityLabel: res.qualityLabel,
    qualityReasons: res.qualityReasons || [],
    sideA: res.sideA,
    sideB: res.sideB,
    gaitSpeed: gaitSpeed == null ? null : Math.round(gaitSpeed * 1000) / 1000,
    stepLength: stepLength == null ? null : Math.round(stepLength * 1000) / 1000,
    intervalDts: intervals.map((x) => Math.round(x.dt * 1000) / 1000),
    intervalSides: intervals.map((x) => x.side),
    demo: res.mode === 'demo' || Number.isFinite(res.demoTruthSteps),
    note: (note || '').slice(0, 600),
  };
}

function saveCurrent() {
  if (!state.current) return;
  const manual = readManualInput();
  if (manual === undefined) return;
  const note = ui.resultNoteInput.value.trim().slice(0, 600);

  if (state.current.stored || state.current.savedId) {
    const id = state.current.savedId || state.current.storedSession?.id;
    if (!id) return;
    const updated = updateSession(id, { manualCount: manual, note });
    if (updated) {
      state.current.storedSession = updated;
      state.current.manual = manual;
      state.current.note = note;
      if (state.current.stored) state.current.res = resultFromSession(updated);
      ui.saveBtn.textContent = '변경 저장';
      toast('변경 사항을 저장했습니다.');
      if (manual > 0) compareManual({ persist: false, silent: true });
      refreshAfterDataChange();
    } else {
      toast('저장된 기록을 찾을 수 없습니다.', 'error');
    }
    return;
  }

  if (!state.current.res.ok) {
    toast('검출된 걸음이 부족해 기록으로 저장할 수 없습니다.', 'error');
    return;
  }
  const record = buildRecord(state.current.res, manual, note);
  addSession(record);
  state.current.savedId = record.id;
  state.current.savedSession = record;
  state.current.manual = manual;
  state.current.note = note;
  ui.saveBtn.textContent = '변경 저장';
  ui.discardBtn.textContent = '삭제';
  toast('기록을 저장했습니다. 기록 화면에서 확인할 수 있습니다.');
  if (manual > 0) compareManual({ persist: false, silent: true });
  refreshAfterDataChange();
}

async function discardCurrent() {
  if (!state.current) {
    showScreen('measure');
    return;
  }
  const saved = !!state.current.savedId;
  const stored = !!state.current.stored;
  const ok = await askConfirm({
    title: saved ? '저장된 기록을 삭제할까요?' : '이 측정을 삭제할까요?',
    body: saved
      ? '삭제하면 기록과 검증 대시보드에서도 사라집니다. 이 작업은 되돌릴 수 없습니다.'
      : '아직 저장하지 않은 측정입니다. 삭제하면 결과가 사라집니다.',
    confirm: '삭제',
    danger: true,
  });
  if (!ok) return;
  if (saved) deleteSession(state.current.savedId);
  state.current = null;
  refreshAfterDataChange();
  showScreen(stored ? 'history' : 'measure');
  toast(saved ? '기록을 삭제했습니다.' : '측정을 삭제했습니다.');
}

async function leaveResult() {
  if (!state.current) { showScreen('measure'); return; }
  if (state.current.stored) { showScreen(state.resultReturn || 'history'); return; }
  if (state.current.savedId) { showScreen('measure'); return; }
  const ok = await askConfirm({
    title: '저장하지 않고 돌아갈까요?',
    body: '이번 측정 결과가 저장되지 않고 사라집니다.',
    confirm: '돌아가기',
    danger: true,
  });
  if (ok) {
    state.current = null;
    showScreen('measure');
  }
}

function openSession(id) {
  if (state.measuring) { toast('측정 중에는 기록을 열 수 없습니다.'); return; }
  const s = getSession(id);
  if (!s) { toast('기록을 찾을 수 없습니다.', 'error'); return; }
  state.current = {
    res: resultFromSession(s),
    stored: true,
    storedSession: s,
    savedId: s.id,
    manual: Number(s.manualCount) > 0 ? Number(s.manualCount) : null,
    note: s.note || '',
    createdAt: s.createdAt,
  };
  state.resultReturn = 'history';
  showScreen('result', { nav: 'history' });
  renderResult(state.current);
}

/* ------------------------------------------------------------------ */
/* Recent + history                                                    */
/* ------------------------------------------------------------------ */

function refreshAfterDataChange() {
  renderRecent();
  updateCalibStatus();
  if (state.currentScreen === 'history') renderHistory();
  if (state.currentScreen === 'validation') renderValidation();
}

function demoTag() {
  const tag = document.createElement('span');
  tag.className = 'tag-mini';
  tag.textContent = 'DEMO';
  return tag;
}

function renderRecent() {
  const all = getSessions();
  const latest = all.find((s) => !s.demo) || all[0];
  if (!latest) {
    ui.recentBlock.hidden = true;
    ui.recentCard.replaceChildren();
    return;
  }
  ui.recentBlock.hidden = false;
  const main = document.createElement('div');
  main.className = 'recent-card__main';
  const strong = document.createElement('strong');
  strong.textContent = `${latest.protocolLabel || '보행'} · ${NF.format(latest.steps)}보`;
  if (latest.demo) strong.appendChild(demoTag());
  const small = document.createElement('small');
  small.textContent = `${shortDate(latest.createdAt)} ${timeText(latest.createdAt)} · 품질 ${latest.qualityLabel || '—'} · ${latest.source === 'demo' ? '데모' : '센서'}`;
  main.append(strong, small);

  const stat = (label, value) => {
    const d = document.createElement('div');
    d.className = 'rc-stat';
    const s = document.createElement('span');
    s.textContent = label;
    const b = document.createElement('strong');
    b.textContent = value;
    d.append(s, b);
    return d;
  };

  const detail = document.createElement('button');
  detail.type = 'button';
  detail.className = 'text-btn';
  detail.dataset.sessionId = latest.id;
  detail.innerHTML = '상세 보기 <svg class="ico ico--sm"><use href="#i-arrow"/></svg>';

  ui.recentCard.replaceChildren(
    main,
    stat('케이던스', `${fmtNum(latest.cadence)} spm`),
    stat('비대칭', `${fmtNum(latest.asymmetry, 1)}%`),
    stat('품질', `${fmtNum(latest.quality)}/100`),
    detail,
  );
}

function historyDatasets() {
  const all = getSessions();
  const real = all.filter((s) => !s.demo);
  const use = real.length ? real : all;
  return { all, real, use, demoOnly: !real.length && all.length > 0 };
}

function renderHistory() {
  const { all, use, demoOnly } = historyDatasets();
  const demos = all.filter((s) => s.demo).length;

  const stats = [
    ['총 세션', `${use.length}`, '회'],
    ['누적 걸음', `${NF.format(use.reduce((a, s) => a + (s.steps || 0), 0))}`, '보'],
    ['평균 케이던스', use.length ? `${Math.round(use.reduce((a, s) => a + (s.cadence || 0), 0) / use.length)}` : '—', 'spm'],
    ['평균 품질', use.length ? `${Math.round(use.reduce((a, s) => a + (s.quality || 0), 0) / use.length)}` : '—', '/100'],
  ];
  ui.historyStats.replaceChildren(...stats.map(([label, value, unit]) => {
    const d = document.createElement('div');
    d.className = 'stat';
    const s = document.createElement('span');
    s.textContent = label;
    const b = document.createElement('strong');
    b.textContent = value;
    const u = document.createElement('small');
    u.textContent = unit;
    d.append(s, b, u);
    return d;
  }));

  const cadencePoints = use
    .filter((s) => Number.isFinite(s.cadence) && s.cadence > 0)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-12)
    .map((s) => ({ t: s.createdAt, value: s.cadence }));
  const asymPoints = use
    .filter((s) => Number.isFinite(s.asymmetry))
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .slice(-12)
    .map((s) => ({ t: s.createdAt, value: s.asymmetry }));
  drawTrend(ui.trendCadence, cadencePoints, { color: '#35e3c2', decimals: 0 });
  drawTrend(ui.trendAsym, asymPoints, { color: '#7fa6ff', decimals: 1 });

  ui.sessionCount.textContent = all.length
    ? `${all.length}회${demos ? ` · 데모 ${demos}` : ''}${demoOnly ? ' · 실제 측정 없음' : ''}`
    : '0';

  if (!all.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.innerHTML = '<strong>아직 기록이 없습니다</strong>첫 측정을 저장하면 여기에 표시됩니다. <button class="text-btn" data-nav="measure" type="button">측정 시작</button>';
    ui.sessionList.replaceChildren(empty);
    return;
  }

  const cards = all.map((s) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'session-card';
    card.dataset.sessionId = s.id;

    const date = document.createElement('div');
    date.className = 'session-card__date';
    const day = document.createElement('strong');
    day.textContent = String(new Date(s.createdAt).getDate());
    const month = document.createElement('small');
    month.textContent = `${new Date(s.createdAt).getMonth() + 1}월`;
    date.append(day, month);

    const main = document.createElement('div');
    main.className = 'session-card__main';
    const title = document.createElement('strong');
    title.textContent = s.protocolLabel || PROTOCOLS[s.protocol]?.label || '보행';
    if (s.demo) title.appendChild(demoTag());
    const sub = document.createElement('small');
    sub.textContent = `${timeText(s.createdAt)} · ${s.patientName || '환자 미등록'} · 품질 ${s.qualityLabel || '—'}`;
    main.append(title, sub);

    const sc = (label, value) => {
      const d = document.createElement('div');
      d.className = 'sc';
      const a = document.createElement('span');
      a.textContent = label;
      const b = document.createElement('strong');
      b.textContent = value;
      d.append(a, b);
      return d;
    };

    const arrow = document.createElement('span');
    arrow.className = 'session-card__arrow';
    arrow.innerHTML = '<svg class="ico ico--sm"><use href="#i-arrow"/></svg>';

    card.append(
      date,
      main,
      sc('걸음', NF.format(s.steps)),
      sc('케이던스', `${fmtNum(s.cadence)}`),
      sc('비대칭', `${fmtNum(s.asymmetry, 1)}%`),
      arrow,
    );
    card.addEventListener('click', () => openSession(s.id));
    return card;
  });
  ui.sessionList.replaceChildren(...cards);
}

// MODULE_CONTINUE_4

/* ------------------------------------------------------------------ */
/* Validation dashboard                                                */
/* ------------------------------------------------------------------ */

function sensitivityLabel() {
  const s = getSettings();
  return SENSITIVITY_PRESETS[s.sensitivity]?.label || '표준';
}

function updateCalibStatus() {
  const cal = getCalibration();
  const demoOnly = cal?.source === 'demo';
  if (cal?.params) {
    ui.calibStatus.textContent = demoOnly
      ? `데모 보정 저장됨 · 실제 센서 측정에는 미적용 (검출 ${cal.detected ?? '—'} / 관찰 ${cal.count ?? '—'}보)`
      : `개인 보정 적용 중 · 검출 ${cal.detected ?? '—'} / 관찰 ${cal.count ?? '—'}보 (오차 ${fmtSigned(cal.errorPct || 0, 1)}%)`;
    ui.calibStatus.style.color = 'var(--amber)';
    ui.calibReset.hidden = false;
    ui.calibBtn.textContent = '보정 다시 측정';
    ui.measureCalibStatus.textContent = demoOnly
      ? '실제 센서 측정에는 미적용'
      : `오차 ${fmtSigned(cal.errorPct || 0, 1)}% · 다음 측정부터 적용`;
    ui.measureCalibBadge.textContent = demoOnly ? '데모' : '적용 중';
  } else {
    ui.calibStatus.textContent = `현재: 기본 설정 (${sensitivityLabel()})`;
    ui.calibStatus.style.color = '';
    ui.calibReset.hidden = true;
    ui.calibBtn.textContent = '보정 측정 시작';
    ui.measureCalibStatus.textContent = `기본 설정(${sensitivityLabel()}) · 30초 이상 측정`;
    ui.measureCalibBadge.textContent = '권장';
  }
  ui.measureCalibBtn.classList.toggle('is-applied', !!cal?.params && !demoOnly);
  ui.measureCalibBtn.classList.toggle('is-demo', demoOnly);
  const meta = SENSITIVITY_PRESETS[getSettings().sensitivity]?.label || '표준';
  ui.sensitivityMeta.textContent = cal?.params
    ? (cal.source === 'demo' ? `${meta} · 데모 보정(미적용)` : `${meta} · 개인 보정 우선`)
    : meta;
}

function renderValidation() {
  const all = getSessions().filter((s) => Number(s.manualCount) > 0 && Number(s.steps) > 0);
  const real = all.filter((s) => !s.demo);
  const use = real.length ? real : all;
  const demoOnly = !real.length && all.length > 0;
  const n = use.length;

  updateCalibStatus();
  ui.valCount.textContent = demoOnly ? `데모 ${n}건` : `${n}회 비교`;
  ui.valCount.classList.toggle('pill--quiet', true);

  if (!n) {
    ui.valMape.textContent = '—';
    ui.valSummary.textContent = '관찰자 계수가 입력된 측정이 없습니다. 결과 화면에서 계수를 입력하면 자동으로 집계됩니다.';
    ui.valSummary.style.color = '';
    ui.valKpis.replaceChildren();
    drawBlandAltman(ui.blandAltman, null);
    return;
  }

  const device = use.map((s) => Number(s.steps));
  const manual = use.map((s) => Number(s.manualCount));
  const ba = blandAltman(device, manual);
  const mapeValue = mape(device, manual);
  const maeValue = mae(device, manual);
  const icc = icc21(device, manual);
  const cccValue = ccc(device, manual);
  const coverage = withinLoa(ba);

  ui.valMape.textContent = mapeValue.toFixed(1);
  const demos = getSessions().filter((s) => s.demo).length;
  if (demoOnly) {
    ui.valSummary.textContent = `데모 데이터 ${n}건 기준입니다. 실제 임상 검증 결과가 아니며, 편향 ${fmtSigned(ba.bias, 1)}보 · 95% 일치 한계 ${fmtSigned(ba.loaLower, 1)}~${fmtSigned(ba.loaUpper, 1)}보입니다.`;
    ui.valSummary.style.color = 'var(--amber)';
  } else {
    ui.valSummary.textContent = `실측 ${n}회 · 평균 절대오차 ${maeValue.toFixed(1)}보 · 편향 ${fmtSigned(ba.bias, 1)}보 · 95% 일치 한계 ${fmtSigned(ba.loaLower, 1)}~${fmtSigned(ba.loaUpper, 1)}보${demos ? ` · 데모 ${demos}건 제외` : ''}.`;
    ui.valSummary.style.color = '';
  }

  const kpis = [
    ['MAE', `${maeValue.toFixed(1)}보`],
    ['편향', `${fmtSigned(ba.bias, 1)}보`],
    [n >= 3 ? 'ICC(2,1)' : 'ICC', n >= 3 && icc != null ? icc.toFixed(2) : '—'],
  ];
  ui.valKpis.replaceChildren(...kpis.map(([label, value]) => {
    const d = document.createElement('div');
    d.className = 'val-kpi';
    const s = document.createElement('span');
    s.textContent = label;
    const b = document.createElement('strong');
    b.textContent = value;
    d.append(s, b);
    return d;
  }));

  drawBlandAltman(ui.blandAltman, {
    device,
    manual,
    diffs: ba.diffs,
    bias: ba.bias,
    loaUpper: ba.loaUpper,
    loaLower: ba.loaLower,
    n: ba.n,
  });

  // Keep these values available for the console/QC without claiming more
  // precision than the sample supports.
  ui.blandAltman.dataset.withinLoa = coverage.toFixed(0);
  ui.blandAltman.dataset.ccc = cccValue == null ? '' : cccValue.toFixed(2);
}

/* ------------------------------------------------------------------ */
/* Personal calibration                                                */
/* ------------------------------------------------------------------ */

function openCalibModal(origin = state.calibOrigin || 'validation') {
  state.calibOrigin = origin;
  const rec = state.calibRecording;
  if (rec) {
    const demo = rec.mode === 'demo';
    ui.calibIntro.textContent = demo
      ? '데모 녹음이 준비되었습니다. 데모의 정답 걸음 수가 미리 입력되어 있습니다. 그대로 계산해 보정 흐름을 확인할 수 있습니다. 데모 보정은 실제 센서 측정에 적용되지 않습니다.'
      : '녹음이 준비되었습니다. 관찰자가 센 걸음 수를 입력하면 같은 기록에서 최적 임계값을 찾습니다.';
    ui.calibRec.hidden = false;
    ui.calibRec.className = 'compare-result';
    ui.calibRec.innerHTML = `<strong>${demo ? '데모' : '센서'} 녹음 · ${fmtClock(rec.durationSec)}</strong><div class="hint" style="margin-top:5px">${
      demo && rec.truthSteps ? `정답 ${rec.truthSteps}보` : `현재 설정 검출 ${rec.steps}보`
    }</div>`;
    ui.calibCount.disabled = false;
    ui.calibCountLabel.textContent = demo ? '관찰자 계수 (데모 정답)' : '관찰자 계수';
    ui.calibCount.value = demo ? String(rec.truthSteps || rec.steps) : '';
    ui.calibDuration.disabled = true;
    ui.calibDurationLabel.textContent = '녹음 시간';
    ui.calibDuration.value = String(Math.round(rec.durationSec));
    ui.calibRun.textContent = '보정 계산';
    ui.calibRedo.hidden = false;
    ui.calibHint.textContent = '관찰자 계수는 앱의 검출값이 아니라 직접 센 값을 사용해야 합니다. 30초 이상 녹음을 권장합니다.';
  } else {
    ui.calibIntro.textContent = '환자가 걷는 동안 관찰자가 직접 걸음 수를 세고, 녹음이 끝나면 계수를 입력합니다. 앱이 같은 기록을 다시 분석해 가장 잘 맞는 임계값을 찾습니다.';
    ui.calibRec.hidden = true;
    ui.calibCount.disabled = true;
    ui.calibCountLabel.textContent = '관찰자 계수';
    ui.calibCount.value = '';
    ui.calibCount.placeholder = '녹음 후 입력';
    ui.calibDuration.disabled = false;
    ui.calibDurationLabel.textContent = '측정 시간 (초)';
    if (!ui.calibDuration.value) ui.calibDuration.value = '60';
    ui.calibRun.textContent = '녹음 시작';
    ui.calibRedo.hidden = true;
    ui.calibHint.textContent = '녹음 중에는 앱이 걸음 수와 파형을 숨깁니다. 관찰자는 앱을 보지 말고 직접 세어 주세요.';
  }
  modalOpen(ui.modalCalib);
}

async function startCalibrationRecording() {
  let duration = Number(ui.calibDuration.value);
  if (!Number.isFinite(duration)) duration = 60;
  duration = Math.round(Math.min(300, Math.max(20, duration)));
  ui.calibDuration.value = String(duration);

  let mode = 'demo';
  if (SessionController.sensorAvailable()) {
    const permission = await SessionController.requestPermission();
    if (permission === 'granted') mode = 'sensor';
    else toast('센서 권한이 없어 데모 신호로 보정합니다. 실제 보정은 센서 권한을 허용해야 합니다.', 'error');
  }

  state.calibRecording = null;
  modalClose(ui.modalCalib);
  await startSession(mode, {
    calibration: true,
    demoProfile: 'cane',
    protocol: {
      key: 'calib',
      label: '개인 보정',
      target: duration,
      hint: '보정 녹음',
    },
  });
}

async function runCalibration() {
  if (state.calibBusy || !state.calibRecording) return;
  const count = Number(ui.calibCount.value);
  if (!Number.isInteger(count) || count < 5 || count > 9999) {
    toast('관찰자 계수는 5–9999 사이의 정수로 입력하세요.', 'error');
    ui.calibCount.focus();
    return;
  }

  state.calibBusy = true;
  const previous = ui.calibRun.textContent;
  ui.calibRun.disabled = true;
  ui.calibRun.textContent = '계산 중…';
  ui.calibHint.textContent = '같은 녹음에 여러 임계값을 적용해 가장 가까운 조합을 찾고 있습니다.';
  await new Promise((resolve) => setTimeout(resolve, 30));

  try {
    const rec = state.calibRecording;
    const base = SENSITIVITY_PRESETS[getSettings().sensitivity] || {};
    const result = calibrate(rec.raw.t, rec.raw.v, rec.raw.yaw, count, { base });
    const improved = Math.abs(result.errorPct) < Math.abs(result.baselineErrorPct);
    const exact = result.count === count;

    ui.calibRec.hidden = false;
    ui.calibRec.className = `compare-result ${Math.abs(result.errorPct) <= 3 ? 'is-good' : 'is-warn'}`;
    ui.calibRec.innerHTML = `
      <div><strong>${result.count}보</strong> 검출 · 관찰 ${count}보</div>
      <div class="hint" style="margin-top:5px">오차 ${fmtSigned(result.errorPct, 1)}% · 보정 전 ${fmtSigned(result.baselineErrorPct, 1)}% · ${result.runs}개 조합 탐색</div>`;

    if (!exact && !improved) {
      ui.calibHint.textContent = '보정으로 오차가 줄지 않아 저장하지 않았습니다. 관찰자 계수를 확인하거나 더 길게 다시 녹음하세요.';
      return;
    }
    if (Math.abs(result.errorPct) > 12) {
      ui.calibHint.textContent = '보정 후에도 오차가 12%를 넘습니다. 이 녹음은 저장하지 않았습니다. 더 안정적인 보행으로 다시 시도하세요.';
      return;
    }

    setCalibration({
      params: result.params,
      count,
      detected: result.count,
      errorPct: result.errorPct,
      baselineCount: result.baselineCount,
      baselineErrorPct: result.baselineErrorPct,
      durationSec: result.durationSec,
      createdAt: Date.now(),
      source: rec.mode,
    });
    state.calibRecording = null;
    modalClose(ui.modalCalib);
    refreshAfterDataChange();
    toast(rec.mode === 'demo'
      ? '데모 보정을 저장했습니다. 실제 센서 측정에는 적용되지 않습니다.'
      : '개인 보정을 저장했습니다. 다음 측정부터 적용됩니다.');
  } catch (error) {
    console.error(error);
    ui.calibHint.textContent = error?.message || '보정 계산에 실패했습니다.';
    toast(error?.message || '보정 계산에 실패했습니다.', 'error');
  } finally {
    state.calibBusy = false;
    ui.calibRun.disabled = false;
    ui.calibRun.textContent = previous;
  }
}

async function handleCalibRun() {
  if (state.calibRecording) {
    await runCalibration();
  } else {
    await startCalibrationRecording();
  }
}

async function resetCalibration() {
  if (!getCalibration()) return;
  const ok = await askConfirm({
    title: '개인 보정을 초기화할까요?',
    body: '다음 측정부터 표준 감도 설정이 적용됩니다. 저장된 보정값만 지우고 기록은 유지합니다.',
    confirm: '초기화',
    danger: true,
  });
  if (!ok) return;
  setCalibration(null);
  renderValidation();
  hydrateSettings();
  toast('개인 보정을 초기화했습니다.');
}

// MODULE_CONTINUE_5

/* ------------------------------------------------------------------ */
/* Settings, diagnostics and data tools                                */
/* ------------------------------------------------------------------ */

function hydrateSettings() {
  const p = getProfile();
  const s = getSettings();
  ui.setName.value = p.name || '';
  ui.setSide.value = p.side || 'none';
  ui.setAid.value = p.aid || 'none';
  ui.setHeight.value = p.heightCm || '';
  ui.setLargeText.checked = !!s.largeText;
  ui.setContrast.checked = !!s.contrast;
  ui.setMotion.checked = !!s.reduceMotion;
  ui.setWake.checked = s.wakeLock !== false;
  $$('#sensitivityGroup .seg').forEach((b) => {
    b.classList.toggle('is-active', b.dataset.sens === s.sensitivity);
  });
  ui.sensitivityMeta.textContent = SENSITIVITY_PRESETS[s.sensitivity]?.label || '표준';
  updateCalibStatus();
}

function saveProfileForm() {
  const name = ui.setName.value.trim().slice(0, 40);
  const height = Number(ui.setHeight.value);
  if (ui.setHeight.value && (!Number.isFinite(height) || height < 100 || height > 220)) {
    toast('키는 100–220 cm 사이로 입력하세요.', 'error');
    ui.setHeight.focus();
    return;
  }
  setProfile({
    name,
    side: ui.setSide.value,
    aid: ui.setAid.value,
    heightCm: ui.setHeight.value ? String(Math.round(height)) : '',
  });
  applyProfile();
  toast('환자 정보를 저장했습니다.');
}

function selectSensitivity(key) {
  if (!SENSITIVITY_PRESETS[key]) return;
  setSettings({ sensitivity: key });
  $$('#sensitivityGroup .seg').forEach((b) => b.classList.toggle('is-active', b.dataset.sens === key));
  ui.sensitivityMeta.textContent = SENSITIVITY_PRESETS[key]?.label || '표준';
  updateCalibStatus();
}

async function runDiagnostics() {
  if (state.diagBusy) return;
  if (state.measuring) { toast('측정 중에는 센서 점검을 실행할 수 없습니다.'); return; }
  state.diagBusy = true;
  ui.diagBtn.disabled = true;
  ui.diagBtn.textContent = '점검 중…';
  ui.diagState.textContent = '점검 중 0%';
  ui.diagBar.style.width = '0%';
  ui.diagAccel.textContent = '—';
  ui.diagGyro.textContent = '—';
  ui.diagRate.textContent = '—';
  ui.diagGravity.textContent = '—';

  const started = performance.now();
  const progress = setInterval(() => {
    const pct = Math.min(96, ((performance.now() - started) / 10000) * 100);
    ui.diagState.textContent = `점검 중 ${Math.round(pct)}%`;
    ui.diagBar.style.width = `${pct}%`;
  }, 200);

  try {
    const res = await SessionController.diagnose(10);
    clearInterval(progress);
    if (!res.supported) {
      ui.diagState.textContent = '미지원';
      ui.diagAccel.textContent = '없음';
      ui.diagGyro.textContent = '없음';
      ui.diagRate.textContent = '—';
      ui.diagGravity.textContent = '—';
      ui.diagBar.style.width = '0%';
      toast('이 브라우저에서는 동작 센서를 사용할 수 없습니다.', 'error');
      return;
    }
    if (res.error) {
      ui.diagState.textContent = '권한 필요';
      toast(res.error, 'error');
      ui.diagBar.style.width = '0%';
      return;
    }
    ui.diagAccel.textContent = res.samples ? `정상 · ${res.samples}개` : '응답 없음';
    ui.diagGyro.textContent = res.gyro > 0.001 ? '정상' : '응답 없음';
    ui.diagRate.textContent = `${res.rate} Hz`;
    const gravityOk = res.mag > 8.5 && res.mag < 11;
    ui.diagGravity.textContent = `${res.mag.toFixed(2)} m/s²${gravityOk ? '' : ' · 확인 필요'}`;
    ui.diagBar.style.width = `${Math.min(100, (res.rate / 60) * 100)}%`;
    ui.diagState.textContent = res.samples ? (gravityOk ? '정상' : '확인 필요') : '응답 없음';
    if (!res.samples) toast('가속도 이벤트가 없습니다. 권한과 브라우저를 확인하세요.', 'error');
    else if (!gravityOk) toast('중력 크기가 비정상입니다. 센서 단위를 확인하세요.', 'error');
    else toast(`센서 점검 완료 · ${res.rate} Hz`);
  } catch (error) {
    clearInterval(progress);
    ui.diagState.textContent = '오류';
    toast('센서 점검에 실패했습니다.', 'error');
  } finally {
    state.diagBusy = false;
    ui.diagBtn.disabled = false;
    ui.diagBtn.textContent = '10초 점검 다시 실행';
    sensorReadyChip();
  }
}

async function runBenchmarkClick() {
  if (state.benchmarkBusy) return;
  if (state.measuring) { toast('측정 중에는 벤치마크를 실행할 수 없습니다.'); return; }
  state.benchmarkBusy = true;
  ui.runBenchmark.disabled = true;
  ui.benchResult.hidden = false;
  ui.benchResult.className = 'compare-result';
  ui.benchResult.innerHTML = '<strong>합성 보행 벤치마크 실행 중…</strong><div class="hint" style="margin-top:5px">5개 보행 유형 × 5회 · 120초</div>';

  try {
    const result = await runBenchmark({
      duration: 120,
      seeds: [1, 2, 3, 4, 5],
      onProgress: ({ done, total, profile, seed }) => {
        ui.benchResult.innerHTML = `<strong>분석 중 ${done}/${total}</strong><div class="hint" style="margin-top:5px">${profile} · seed ${seed}</div>`;
      },
    });
    const per = result.byProfile.map((p) => `${p.label} ${p.meanAbsPct.toFixed(1)}%`).join(' · ');
    ui.benchResult.className = 'compare-result is-good';
    ui.benchResult.innerHTML = `
      <div><strong>MAPE ${result.mape.toFixed(2)}%</strong> · 최대 ${result.maxErrorPct.toFixed(1)}% · 평균 비대칭 오차 ${result.meanAsymError.toFixed(1)}pp</div>
      <div class="hint" style="margin-top:6px">합성 보행 ${result.runs}회 · 120초 · ${per}</div>
      <div class="hint">합성 신호 결과이며 실제 환자 대상 임상 타당도 검증을 대체하지 않습니다.</div>`;
    toast(`벤치마크 완료 · MAPE ${result.mape.toFixed(2)}%`);
  } catch (error) {
    console.error(error);
    ui.benchResult.className = 'compare-result is-bad';
    ui.benchResult.innerHTML = '<strong>벤치마크 실행 실패</strong><div class="hint" style="margin-top:5px">브라우저 콘솔을 확인하세요.</div>';
    toast('벤치마크 실행에 실패했습니다.', 'error');
  } finally {
    state.benchmarkBusy = false;
    ui.runBenchmark.disabled = false;
  }
}

function exportData() {
  const sessions = getSessions();
  if (!sessions.length) { toast('내보낼 기록이 없습니다.', 'error'); return; }
  downloadCsv();
  toast(`CSV로 ${sessions.length}개 세션을 내보냈습니다.`);
}

function seedDemos() {
  seedDemoSessions();
  refreshAfterDataChange();
  showScreen('history');
  toast('데모 세션 8개를 생성했습니다. 실제 임상 데이터가 아닙니다.');
}

async function clearAllData() {
  const ok = await askConfirm({
    title: '모든 기록을 삭제할까요?',
    body: '세션 기록과 개인 보정값이 이 기기에서 모두 삭제됩니다. 이 작업은 되돌릴 수 없습니다.',
    confirm: '모두 삭제',
    danger: true,
  });
  if (!ok) return;
  clearAll();
  state.current = null;
  state.calibRecording = null;
  ui.diagState.textContent = '대기';
  hydrateSettings();
  refreshAfterDataChange();
  showScreen('measure');
  toast('모든 기록과 보정값을 삭제했습니다.');
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

function bindEvents() {
  document.addEventListener('click', (event) => {
    const nav = event.target.closest('[data-nav]');
    if (nav) {
      event.preventDefault();
      navigate(nav.dataset.nav);
    }
  });

  ui.quickSettings.addEventListener('click', () => navigate('settings'));
  ui.railPatient.addEventListener('click', () => navigate('settings'));
  ui.editProfile.addEventListener('click', () => {
    navigate('settings').then(() => ui.setName?.focus());
  });
  ui.startBtn.addEventListener('click', openStartModal);

  $$('#protocolGroup .seg').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.measuring) return;
      selectProtocol(btn.dataset.protocol);
    });
  });

  ui.useDemo.addEventListener('click', () => {
    modalClose(ui.modalStart);
    startSession('demo');
  });
  ui.allowSensor.addEventListener('click', async () => {
    ui.allowSensor.disabled = true;
    const permission = await SessionController.requestPermission();
    ui.allowSensor.disabled = false;
    if (permission === 'granted') {
      modalClose(ui.modalStart);
      startSession('sensor');
    } else {
      ui.modalStartHint.textContent = '권한이 거부되었습니다. 브라우저 설정에서 동작 센서 권한을 허용하거나 데모로 체험하세요.';
      toast('동작 센서 권한이 필요합니다.', 'error');
    }
  });

  $$('[data-close]', ui.modalStart).forEach((b) => b.addEventListener('click', () => modalClose(ui.modalStart)));
  $$('[data-close]', ui.modalCalib).forEach((b) => b.addEventListener('click', () => modalClose(ui.modalCalib)));
  $$('[data-close]', ui.modalConfirm).forEach((b) => b.addEventListener('click', () => settleConfirm(false)));
  ui.confirmStop.addEventListener('click', () => settleConfirm(true));

  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!ui.modalConfirm.hidden) settleConfirm(false);
    else if (!ui.modalStart.hidden) modalClose(ui.modalStart);
    else if (!ui.modalCalib.hidden) modalClose(ui.modalCalib);
  });

  ui.pauseBtn.addEventListener('click', togglePause);
  ui.stopBtn.addEventListener('click', requestStop);
  ui.liveSettingsBtn.addEventListener('click', () => toast('측정을 종료한 뒤 설정을 변경할 수 있습니다.'));

  ui.manualToggle.addEventListener('change', () => {
    ui.manualBtn.disabled = !ui.manualToggle.checked || !!state.live?.paused;
  });
  ui.manualBtn.addEventListener('click', () => {
    if (!state.live || ui.manualBtn.disabled) return;
    state.live.manual++;
    ui.manualCount.textContent = String(state.live.manual);
    try { navigator.vibrate?.(8); } catch { /* ignore */ }
  });
  ui.soundToggle.addEventListener('change', () => {
    setSettings({ sound: ui.soundToggle.checked });
    if (state.live) state.live.sound = ui.soundToggle.checked;
    if (ui.soundToggle.checked) ensureAudio();
  });
  ui.vibeToggle.addEventListener('change', () => {
    setSettings({ haptic: ui.vibeToggle.checked });
    if (state.live) state.live.haptic = ui.vibeToggle.checked;
  });

  ui.resultBack.addEventListener('click', leaveResult);
  ui.compareBtn.addEventListener('click', () => compareManual({ persist: true }));
  ui.manualInput.addEventListener('input', () => {
    ui.compareResult.hidden = true;
  });
  ui.saveBtn.addEventListener('click', saveCurrent);
  ui.discardBtn.addEventListener('click', discardCurrent);

  ui.recentCard.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-session-id]');
    if (btn) openSession(btn.dataset.sessionId);
  });
  ui.exportBtn.addEventListener('click', exportData);

  ui.calibBtn.addEventListener('click', () => openCalibModal('validation'));
  ui.measureCalibBtn.addEventListener('click', () => openCalibModal('measure'));
  ui.calibRun.addEventListener('click', handleCalibRun);
  ui.calibRedo.addEventListener('click', () => {
    state.calibRecording = null;
    openCalibModal();
  });
  ui.calibReset.addEventListener('click', resetCalibration);
  ui.runBenchmark.addEventListener('click', runBenchmarkClick);

  ui.saveProfile.addEventListener('click', saveProfileForm);
  $$('#sensitivityGroup .seg').forEach((btn) => {
    btn.addEventListener('click', () => selectSensitivity(btn.dataset.sens));
  });
  ui.setLargeText.addEventListener('change', () => {
    setSettings({ largeText: ui.setLargeText.checked });
    applyDisplaySettings();
  });
  ui.setContrast.addEventListener('change', () => {
    setSettings({ contrast: ui.setContrast.checked });
    applyDisplaySettings();
  });
  ui.setMotion.addEventListener('change', () => {
    setSettings({ reduceMotion: ui.setMotion.checked });
    applyDisplaySettings();
  });
  ui.setWake.addEventListener('change', () => {
    setSettings({ wakeLock: ui.setWake.checked });
    if (!ui.setWake.checked) toast('다음 측정부터 화면 켜짐 유지를 사용하지 않습니다.');
  });
  ui.diagBtn.addEventListener('click', runDiagnostics);
  ui.exportBtn2.addEventListener('click', exportData);
  ui.demoBtn.addEventListener('click', seedDemos);
  ui.clearBtn.addEventListener('click', clearAllData);

  window.addEventListener('resize', () => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => {
      if (state.currentScreen === 'live' && state.live?.lastSnap && !state.live.calib) {
        const snap = state.live.lastSnap;
        drawLiveWave(ui.liveWave, { t: snap.recent.t, v: snap.recent.v, duration: snap.recent.duration }, snap.stepTimes, { paused: state.live.paused });
      } else if (state.currentScreen === 'result' && state.current) {
        drawTachogram(ui.tachogram, state.current.res.intervals || []);
      } else if (state.currentScreen === 'history') {
        renderHistory();
      } else if (state.currentScreen === 'validation') {
        renderValidation();
      }
    }, 160);
  });

  window.addEventListener('beforeunload', (event) => {
    if (state.measuring || (state.current && !state.current.savedId && !state.current.stored)) {
      event.preventDefault();
      event.returnValue = '';
    }
  });
}

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if (location.protocol !== 'https:' && !local) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('서비스 워커 등록 실패', error);
    });
  });
}

function init() {
  applyDisplaySettings();
  applyProfile();
  hydrateSettings();
  selectProtocol('free');
  renderRecent();
  sensorReadyChip();
  bindEvents();
  registerServiceWorker();
  const action = new URLSearchParams(location.search).get('action');
  if (action === 'history' || action === 'validation' || action === 'settings') {
    showScreen(action);
  }
}

init();

// MODULE_END





