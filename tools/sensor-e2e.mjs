#!/usr/bin/env node
/**
 * Sensor-path end-to-end check.
 *
 * Desktop Chrome is deliberately treated as demo-only by `sensorAvailable()`,
 * so the real DeviceMotion branch never runs in normal browser QA. This harness
 * launches a separate headless Chrome with a mobile user agent, feeds synthetic
 * `devicemotion` events at 50 Hz, and verifies:
 *   1. sensor mode starts from the UI,
 *   2. live counting updates from acceleration events,
 *   3. stopping produces a sensor-mode result,
 *   4. the settings diagnostics report a plausible gravity magnitude.
 *
 * This validates wiring, not clinical accuracy. Accuracy is covered by
 * `node tools/verify.mjs`.
 *
 * Usage: start a local server (`python3 -m http.server 4173`), then
 *   node tools/sensor-e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173/index.html';
const PORT = Number(process.env.CDP_PORT || 9333);
const CHROME = process.env.CHROME_BIN ||
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const MOBILE_UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id) {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        if (msg.error) pending.reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else pending.resolve(msg.result);
        return;
      }
      for (const listener of this.listeners.get(msg.method) || []) listener(msg.params);
    });
  }

  async send(method, params = {}) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, listener) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(listener);
  }

  async evaluate(script) {
    const result = await this.send('Runtime.evaluate', {
      expression: script,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || 'page evaluation failed');
    }
    return result.result.value;
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForChrome() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch { /* Chrome is still starting */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}

function launchChrome(profileDir) {
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--user-agent=${MOBILE_UA}`,
    'about:blank',
  ];
  return spawn(CHROME, args, { stdio: 'ignore' });
}

const motionScript = `
window.__qaMotion = (() => {
  let timer = null;
  let startedAt = 0;
  let events = 0;
  const dispatch = (t) => {
    const STEP_HZ = 1.6;           // 96 steps/min
    const STRIDE_HZ = STEP_HZ / 2; // one pelvis rotation per stride
    const phase = 2 * Math.PI * STEP_HZ * t;
    const stride = 2 * Math.PI * STRIDE_HZ * t;
    const amplitude = 2.4 * (1 + 0.14 * Math.sin(stride));
    const z = 9.81 + amplitude * Math.sin(phase) + 0.45 * Math.sin(2 * phase + 0.4);
    const x = 0.5 * Math.sin(phase + 0.7) + 0.12 * Math.sin(2 * Math.PI * 0.23 * t);
    const y = 0.3 * Math.cos(stride + 0.3);
    const rotationRate = {
      alpha: 0,
      beta: 6 * Math.sin(stride + 0.5),
      gamma: 24 * Math.sin(stride),
    };
    window.dispatchEvent(new DeviceMotionEvent('devicemotion', {
      accelerationIncludingGravity: { x, y, z },
      rotationRate,
      interval: 20,
    }));
    events++;
  };
  return {
    start() {
      this.stop();
      startedAt = performance.now();
      events = 0;
      timer = setInterval(() => dispatch((performance.now() - startedAt) / 1000), 20);
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    get events() { return events; },
  };
})();
true;
`;

async function main() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'stridecare-sensor-'));
  const chrome = launchChrome(profileDir);
  let cdp;
  try {
    const wsUrl = await waitForChrome();
    cdp = new CDP(wsUrl);
    await cdp.ready;

    const consoleErrors = [];
    cdp.on('Runtime.consoleAPICalled', (event) => {
      if (event.type === 'error') {
        consoleErrors.push(event.args.map((a) => a.value || a.description || '').join(' '));
      }
    });
    cdp.on('Runtime.exceptionThrown', (event) => {
      consoleErrors.push(event.exceptionDetails?.exception?.description || 'uncaught exception');
    });

    await cdp.send('Runtime.enable');
    await cdp.send('Page.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 390, height: 844, deviceScaleFactor: 3, mobile: true,
      screenWidth: 390, screenHeight: 844,
    });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });

    const loaded = new Promise((resolve) => cdp.on('Page.loadEventFired', resolve));
    await cdp.send('Page.navigate', { url: APP_URL });
    await loaded;
    await sleep(1200);

    const boot = await cdp.evaluate(`({
      sensorReady: document.getElementById('startMeta')?.textContent || '',
      ua: navigator.userAgent,
      touch: navigator.maxTouchPoints,
      dme: typeof DeviceMotionEvent,
    })`);
    if (!/센서|연결/.test(boot.sensorReady)) {
      throw new Error(`expected sensor-ready start meta, got "${boot.sensorReady}"`);
    }
    await cdp.evaluate(motionScript);

    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('startBtn').click();
      await sleep(300);
      document.getElementById('allowSensor').click();
      await sleep(500);
    })()`);
    const started = await cdp.evaluate(`({
      screen: document.querySelector('.screen.is-active')?.id,
      source: document.getElementById('liveSource')?.textContent,
      chip: document.getElementById('sensorChip')?.textContent.trim(),
      note: document.getElementById('liveNote')?.textContent.trim(),
      visibility: document.visibilityState,
    })`);
    if (started.screen !== 'screen-live' || started.source !== '센서') {
      throw new Error(`sensor session did not start: ${JSON.stringify(started)}`);
    }

    await cdp.evaluate('window.__qaMotion.start(); true;');
    await sleep(12000);
    const live = await cdp.evaluate(`({
      steps: Number(document.getElementById('liveSteps').textContent),
      cadence: document.getElementById('liveCadence').textContent,
      hz: document.getElementById('liveHz').textContent,
      quality: document.getElementById('liveQuality').textContent,
      chip: document.getElementById('sensorChip').textContent.trim(),
      note: document.getElementById('liveNote').textContent.trim(),
      events: window.__qaMotion.events,
    })`);
    if (!(live.steps >= 12 && live.steps <= 24)) {
      throw new Error(`expected 12–24 live steps in 12 s, got ${live.steps}`);
    }
    if (live.events < 500) {
      throw new Error(`expected ~600 synthetic events, got ${live.events}`);
    }

    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.getElementById('stopBtn').click();
      await sleep(300);
      document.getElementById('confirmStop').click();
      await sleep(900);
    })()`);
    const result = await cdp.evaluate(`({
      screen: document.querySelector('.screen.is-active')?.id,
      steps: Number(document.getElementById('resultSteps').textContent),
      refined: !document.getElementById('resultRefined').hidden,
      source: document.getElementById('liveSource')?.textContent,
    })`);
    if (result.screen !== 'screen-result' || !(result.steps >= 12 && result.steps <= 24)) {
      throw new Error(`unexpected sensor result: ${JSON.stringify(result)}`);
    }

    await cdp.evaluate(`(async () => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      document.querySelector('[data-nav="settings"]').click();
      await sleep(400);
      document.getElementById('diagBtn').click();
    })()`);
    await sleep(10500);
    const diag = await cdp.evaluate(`({
      state: document.getElementById('diagState').textContent.trim(),
      accel: document.getElementById('diagAccel').textContent.trim(),
      rate: document.getElementById('diagRate').textContent.trim(),
      gravity: document.getElementById('diagGravity').textContent.trim(),
      gyro: document.getElementById('diagGyro').textContent.trim(),
    })`);
    const gravity = Number.parseFloat(diag.gravity);
    if (!/정상/.test(diag.state) || !(gravity > 8.5 && gravity < 11)) {
      throw new Error(`sensor diagnostics failed: ${JSON.stringify(diag)}`);
    }

    await cdp.evaluate('window.__qaMotion.stop(); true;');
    if (consoleErrors.length) {
      throw new Error(`console errors: ${consoleErrors.join(' | ')}`);
    }

    console.log('센서 경로 E2E 통과');
    console.log(JSON.stringify({ boot, started, live, result, diag }, null, 2));
  } finally {
    try { await cdp?.send('Browser.close'); } catch { /* ignore */ }
    cdp?.close();
    chrome.kill('SIGTERM');
    await sleep(500);
    await rm(profileDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('센서 경로 E2E 실패:', error.message);
  process.exitCode = 1;
});
