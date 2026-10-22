/**
 * Live measurement session.
 *
 * One clock is used for real sensors and the demo player: `sessionNow()`
 * excludes paused time, so the recorded signal stays continuous across a
 * pause and the detector never sees a multi-second hole.
 */

import { GaitSignal } from './core/dsp.js';
import { StepTracker, summarize, assessQuality, cadenceAt, assignSides, DEFAULT_PARAMS, SENSITIVITY_PRESETS } from './core/detector.js';
import { simulateGait, GaitPlayer, PROFILES } from './core/simulator.js';

const DEG = Math.PI / 180;

export const PROTOCOLS = {
  free: {
    key: 'free', label: '자유 보행', target: null,
    hint: '편안한 속도로 걸으세요. 종료 버튼을 누를 때까지 계속 측정합니다.',
  },
  '2min': {
    key: '2min', label: '2분 보행', target: 120,
    hint: '2분 동안 가능한 한 편안하고 꾸준하게 걷습니다. 2분이 되면 자동으로 종료됩니다.',
  },
  '6min': {
    key: '6min', label: '6분 보행', target: 360,
    hint: '6분 보행 검사입니다. 6분이 되면 자동으로 종료됩니다. 필요 시 휴식을 기록하세요.',
  },
  '10m': {
    key: '10m', label: '10m 보행', target: null, distance: 10,
    hint: '출발선에서 시작해 10m를 지나면 종료하세요. 보행 속도와 보폭을 계산합니다.',
  },
};

function resolveParams(settings, calibration) {
  const preset = SENSITIVITY_PRESETS[settings?.sensitivity] || {};
  const base = { ...DEFAULT_PARAMS, ...preset };
  if (calibration?.params) return { ...base, ...calibration.params };
  return base;
}

export { resolveParams };

export class SessionController {
  constructor({ onTick, onStep, onEnd, onStatus } = {}) {
    this.onTick = onTick;
    this.onStep = onStep;
    this.onEnd = onEnd;
    this.onStatus = onStatus;

    this.sig = new GaitSignal();
    this.tracker = null;
    this.params = DEFAULT_PARAMS;
    this.mode = 'sensor';
    this.protocol = PROTOCOLS.free;
    this.running = false;
    this.paused = false;
    this.startAt = 0;
    this.pauseAccum = 0;
    this.pauseStart = 0;
    this.timer = null;
    this.wakeLock = null;
    this.record = { t: [], v: [], yaw: [] };
    this.demo = null;
    this.demoPlayer = null;
    this.demoIndex = 0;
    this.demoTruthSteps = 0;
    this.demoTruthSeen = 0;
    this.demoTruthIndex = 0;
    this.demoSegmentStart = 0;
    this.demoOriginT = 0;
    this.demoDuration = 0;
    this.liveSteps = 0;
    this.liveQuality = null;
    this.lastQualityAt = -99;
    this.lastTickAt = 0;
    this.eventCount = 0;
    this.lastRateAt = 0;
    this.eventRate = 0;
    this._motionHandler = (e) => this._onMotion(e);
    this._visHandler = () => this._onVisibility();
    this.started = false;
    this.stopped = false;
    this.stopping = false;
    this.warnedSensor = false;
    this.useWakeLock = true;
  }

  /** Must be called from a user gesture on iOS. */
  static async requestPermission() {
    if (typeof DeviceMotionEvent === 'undefined') return 'unsupported';
    if (typeof DeviceMotionEvent.requestPermission === 'function') {
      try {
        const res = await DeviceMotionEvent.requestPermission();
        return res;
      } catch {
        return 'denied';
      }
    }
    return 'granted';
  }

  static sensorAvailable() {
    if (typeof DeviceMotionEvent === 'undefined') return false;
    // Desktop browsers can expose the constructor without any motion hardware.
    // Require a phone/tablet-like environment so the UI does not promise a
    // sensor that will never emit an event.
    const ua = navigator.userAgent || '';
    const mobileUA = /Android|iPhone|iPad|iPod|Mobile|Tablet/i.test(ua);
    const uaMobile = navigator.userAgentData?.mobile === true;
    return uaMobile || mobileUA || (navigator.maxTouchPoints || 0) > 0;
  }

  sessionNow() {
    const paused = this.paused && this.pauseStart
      ? performance.now() - this.pauseStart
      : 0;
    return (performance.now() - this.pauseAccum - paused) / 1000;
  }

  async start({
    mode = 'sensor',
    protocolKey = 'free',
    protocol = null,
    params,
    demoProfile = 'hemiparetic',
    wakeLock = true,
  } = {}) {
    this.mode = mode;
    this.protocol = protocol || PROTOCOLS[protocolKey] || PROTOCOLS.free;
    this.params = params || DEFAULT_PARAMS;
    this.useWakeLock = wakeLock !== false;
    this.demoProfile = PROFILES[demoProfile] ? PROFILES[demoProfile] : PROFILES.hemiparetic;
    this.tracker = new StepTracker(this.params);
    this.sig.reset();
    this.record = { t: [], v: [], yaw: [] };
    this.liveSteps = 0;
    this.liveQuality = null;
    this.lastQualityAt = -99;
    this.pauseAccum = 0;
    this.paused = false;
    this.stopped = false;
    this.stopping = false;
    this.started = true;
    this.eventCount = 0;
    this.eventRate = 0;
    this.lastRateAt = this.sessionNow();
    this.validMotionEvents = 0;
    this.warnedNullMotion = false;
    this.startAt = this.sessionNow();
    this.lastTickAt = performance.now();

    if (mode === 'demo') {
      const duration = Math.max(180, (this.protocol.target || 120) + 40);
      this.demo = simulateGait({
        duration,
        seed: Math.floor(Math.random() * 1e6),
        profile: this.demoProfile,
      });
      this.demoTruthSteps = 0;
      this.demoTruthSeen = 0;
      this.demoIndex = 0;
      this._startDemo();
      this._status('데모 신호로 측정 중', 'demo');
    } else {
      if (!SessionController.sensorAvailable()) {
        throw new Error('이 브라우저에서는 동작 센서를 사용할 수 없습니다.');
      }
      window.addEventListener('devicemotion', this._motionHandler, { passive: true });
      document.addEventListener('visibilitychange', this._visHandler);
      this._status('센서 연결됨', 'live');
    }

    if (this.useWakeLock) await this._requestWakeLock();
    this.running = true;
    this.lastTickAt = performance.now();
    this.timer = setInterval(() => this._tick(), 100);
    this._tick();
    return true;
  }

  _startDemo() {
    const now = this.sessionNow();
    const profile = this.demoProfile || PROFILES.hemiparetic;
    this.demoPlayer = new GaitPlayer(this.demo, {
      onSample: (t, ax, ay, az, gx, gy, gz) => this._pushSample(t, ax, ay, az, gx, gy, gz),
      onEnd: () => {
        // Loop long sessions by generating more signal from the same profile.
        if (!this.running) return;
        this._syncDemoTruth(this.demoDuration);
        this.demoIndex = 0;
        this.demo = simulateGait({
          duration: 180,
          seed: Math.floor(Math.random() * 1e6),
          profile,
        });
        this._startDemo();
      },
    });
    this.demoPlayer.start(now, this.demoIndex);
    this.demoSegmentStart = now;
    this.demoOriginT = this.demoPlayer.originT;
    this.demoDuration = this.demo.truth.duration;
    const times = this.demo.truth.times;
    let i = 0;
    while (i < times.length && times[i] <= this.demoOriginT + 1e-9) i++;
    this.demoTruthIndex = i;
  }

  _syncDemoTruth(signalTime) {
    if (!this.demo) return;
    const times = this.demo.truth.times;
    while (this.demoTruthIndex < times.length && times[this.demoTruthIndex] <= signalTime + 1e-9) {
      this.demoTruthIndex++;
      this.demoTruthSeen++;
    }
  }

  _demoSignalTime(now = this.sessionNow()) {
    return this.demoOriginT + Math.max(0, now - this.demoSegmentStart);
  }

  _onMotion(e) {
    if (!this.running || this.paused) return;
    const a = e.accelerationIncludingGravity;
    if (!a || (a.x == null && a.y == null && a.z == null)) {
      // Chrome can deliver one warm-up event without acceleration data. Wait a
      // moment before alarming, otherwise the chip stays on "센서 주의" for the
      // rest of a perfectly healthy session.
      if (!this.validMotionEvents && !this.warnedNullMotion && this.sessionNow() >= 2) {
        this.warnedNullMotion = true;
        this._status('가속도 센서 값을 받을 수 없습니다', 'warn');
      }
      return;
    }
    this.validMotionEvents++;
    if (this.warnedNullMotion && this.validMotionEvents >= 8) {
      this.warnedNullMotion = false;
      this._status('센서 연결됨', 'live');
    }
    const r = e.rotationRate || {};
    this._pushSample(
      this.sessionNow(),
      a.x || 0, a.y || 0, a.z || 0,
      (r.alpha || 0) * DEG, (r.beta || 0) * DEG, (r.gamma || 0) * DEG,
    );
  }

  _pushSample(t, ax, ay, az, gx, gy, gz) {
    this.sig.pushRaw(t, ax, ay, az, gx, gy, gz);
    this.eventCount++;
  }

  _tick() {
    if (!this.running || this.paused) return;
    const now = this.sessionNow();
    if (this.mode === 'demo' && this.demo) {
      this._syncDemoTruth(this._demoSignalTime(now));
    }
    const added = this.sig.pump(now);
    for (const f of added) {
      this.record.t.push(f.t);
      this.record.v.push(f.v);
      this.record.yaw.push(f.yaw);
    }
    this.sig.trim(now, 22);

    if (!this.sig.sensorValid && !this.warnedSensor) {
      this.warnedSensor = true;
      this._status('센서 단위가 비정상입니다. 설정에서 점검하세요.', 'warn');
    }

    const fresh = this.tracker.update(this.sig, now);
    this.liveSteps = this.tracker.steps.length;

    for (const s of fresh) {
      const side = s.yaw >= 0 ? 0 : 1;
      this.onStep?.({ t: s.t, side, count: this.liveSteps });
    }

    if (now - this.lastQualityAt > 2 && this.tracker.steps.length >= 4) {
      this.lastQualityAt = now;
      this.liveQuality = assessQuality(this.sig.t, this.sig.v, this.sig.yaw, this.tracker.steps, this.params);
    }

    // Event rate (sensor health).
    if (now - this.lastRateAt >= 1) {
      this.eventRate = Math.round(this.eventCount / Math.max(1e-3, now - this.lastRateAt));
      this.eventCount = 0;
      this.lastRateAt = now;
    }

    const elapsed = now - this.startAt;
    const snap = this.snapshot(now, elapsed);
    this.onTick?.(snap);

    if (this.protocol.target && elapsed >= this.protocol.target) {
      this.stop('auto');
    }
  }

  snapshot(now = this.sessionNow(), elapsed) {
    const dur = elapsed ?? now - this.startAt;
    const steps = this.tracker ? this.tracker.steps : [];
    const sides = assignSides(steps);
    let sideA = 0, sideB = 0;
    sides.sides.forEach((s) => { if (s === 0) sideA++; else sideB++; });

    return {
      elapsed: Math.max(0, dur),
      steps: steps.length,
      cadence: cadenceAt(steps, now, 8),
      quality: this.liveQuality,
      sideA,
      sideB,
      sideSource: sides.source,
      recent: this.recentSignal(now, 8),
      stepTimes: steps.slice(-60).map((s) => ({ t: s.t, side: s.yaw >= 0 ? 0 : 1 })),
      target: this.protocol.target,
      eventRate: this.eventRate,
      paused: this.paused,
      mode: this.mode,
    };
  }

  recentSignal(now, seconds = 8) {
    const cutoff = now - seconds;
    const n = this.sig.t.length;
    let lo = 0;
    while (lo < n && this.sig.t[lo] < cutoff) lo++;
    return {
      t: this.sig.t.slice(lo),
      v: this.sig.v.slice(lo),
      duration: seconds,
    };
  }

  pause() {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.pauseStart = performance.now();
    if (this.mode === 'sensor') {
      window.removeEventListener('devicemotion', this._motionHandler);
    } else if (this.demoPlayer) {
      this._syncDemoTruth(this._demoSignalTime());
      this.demoIndex = this.demoPlayer.i;
      this.demoPlayer.stop();
    }
    this._status('일시정지됨', 'warn');
    this.onTick?.(this.snapshot());
  }

  resume() {
    if (!this.running || !this.paused) return;
    this.pauseAccum += performance.now() - this.pauseStart;
    this.paused = false;
    if (this.mode === 'sensor') {
      window.addEventListener('devicemotion', this._motionHandler, { passive: true });
    } else {
      this._startDemo();
    }
    this._status(this.mode === 'demo' ? '데모 신호로 측정 중' : '센서 연결됨', this.mode === 'demo' ? 'demo' : 'live');
  }

  stop(reason = 'manual') {
    if (!this.running || this.stopped) return null;
    this.stopping = true;
    const now = this.sessionNow();
    const added = this.sig.pump(now);
    for (const f of added) {
      this.record.t.push(f.t);
      this.record.v.push(f.v);
      this.record.yaw.push(f.yaw);
    }
    this.running = false;
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = null;
    window.removeEventListener('devicemotion', this._motionHandler);
    document.removeEventListener('visibilitychange', this._visHandler);
    if (this.demoPlayer) this.demoPlayer.stop();
    this._releaseWakeLock();

    const elapsed = now - this.startAt;
    if (this.mode === 'demo' && this.demo) {
      this._syncDemoTruth(this._demoSignalTime(now));
      this.demoTruthSteps = this.demoTruthSeen;
    }
    let steps = [];
    let error = null;
    try {
      steps = this.tracker.finalize(this.record.t, this.record.v, this.record.yaw);
    } catch (e) {
      error = e;
      console.error('finalize failed', e);
    }
    const summ = summarize(steps);
    const quality = assessQuality(this.record.t, this.record.v, this.record.yaw, steps, this.params);

    // Sides + per-step intervals for the report.
    const { sides } = assignSides(steps);
    const intervals = [];
    for (let i = 1; i < steps.length; i++) {
      intervals.push({
        dt: steps[i].t - steps[i - 1].t,
        side: sides[i],
        t: steps[i].t - steps[0].t,
        recovered: !!steps[i].recovered,
      });
    }

    const result = {
      ok: !error && steps.length >= 2,
      error,
      protocol: this.protocol,
      mode: this.mode,
      stoppedBy: reason,
      durationSec: elapsed,
      walkedSec: summ.duration,
      steps: steps.length,
      cadence: summ.cadence,
      asymmetry: summ.asymmetry,
      asymmetrySigned: summ.asymmetrySigned,
      asymmetrySource: summ.asymmetrySource,
      alternation: summ.alternation,
      intervalCV: summ.intervalCV,
      meanInterval: summ.meanInterval,
      meanAmplitude: summ.meanAmplitude,
      quality: quality.score,
      qualityLabel: quality.label,
      qualityReasons: quality.reasons,
      sideA: sides.filter((s) => s === 0).length,
      sideB: sides.filter((s) => s === 1).length,
      intervals,
      params: this.params,
      raw: this.record,
      liveSteps: this.liveSteps,
      eventRate: this.eventRate,
      demoTruthSteps: this.mode === 'demo' ? this.demoTruthSteps : null,
    };
    this._status('측정이 종료되었습니다', 'idle');
    this.onEnd?.(result);
    return result;
  }

  async _requestWakeLock() {
    if (!this.useWakeLock) return;
    if (!('wakeLock' in navigator)) return;
    try {
      this.wakeLock = await navigator.wakeLock.request('screen');
    } catch { /* not fatal */ }
  }

  async _releaseWakeLock() {
    try { await this.wakeLock?.release(); } catch { /* ignore */ }
    this.wakeLock = null;
  }

  _onVisibility() {
    if (document.visibilityState === 'hidden' && this.running && !this.paused) {
      this._status('화면이 백그라운드로 전환되었습니다. 측정이 중단될 수 있어요.', 'warn');
    } else if (document.visibilityState === 'visible' && this.running && this.useWakeLock && !this.wakeLock) {
      this._requestWakeLock();
    }
  }

  _status(text, kind = 'live') {
    this.onStatus?.({ text, kind });
  }

  /** One-shot 10 s diagnostic used by the settings screen. */
  static async diagnose(durationSec = 10) {
    const res = {
      supported: SessionController.sensorAvailable(),
      samples: 0,
      rate: 0,
      mag: 0,
      gyro: 0,
      hasGravity: false,
      error: null,
    };
    if (!res.supported) return res;
    const perm = await SessionController.requestPermission();
    if (perm !== 'granted') { res.error = '권한이 거부되었습니다.'; return res; }
    return new Promise((resolve) => {
      let count = 0, magSum = 0, gyroSum = 0;
      const started = performance.now();
      const handler = (e) => {
        const a = e.accelerationIncludingGravity;
        if (!a) return;
        res.hasGravity = true;
        count++;
        magSum += Math.hypot(a.x || 0, a.y || 0, a.z || 0);
        const r = e.rotationRate || {};
        gyroSum += Math.hypot(r.alpha || 0, r.beta || 0, r.gamma || 0);
      };
      window.addEventListener('devicemotion', handler, { passive: true });
      setTimeout(() => {
        window.removeEventListener('devicemotion', handler);
        const secs = (performance.now() - started) / 1000;
        res.samples = count;
        res.rate = Math.round(count / secs);
        res.mag = count ? magSum / count : 0;
        res.gyro = count ? gyroSum / count : 0;
        resolve(res);
      }, durationSec * 1000);
    });
  }
}
