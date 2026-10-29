#!/usr/bin/env node
/**
 * Observer remote end-to-end check.
 *
 * Launches headless Chrome, opens the app in two tabs (measuring phone and
 * observer phone), completes the serverless WebRTC pairing through the real UI
 * (copy/paste path, no camera), then verifies:
 *   1. the sensor phone shows the observer as connected,
 *   2. the observer screen appears on the second phone,
 *   3. observer +1/-1 taps reach the sensor phone's manual count,
 *   4. pause/resume/stop commands control the sensor session,
 *   5. the observer screen never renders the automatic step count and no step
 *      field crosses the data channel,
 *   6. the pairing QR encodes the exact same string the code box holds,
 *   7. a healthy link survives the 15 s pairing watchdog,
 *   8. after stopping, the phones re-pair and a new session starts from 0,
 *   9. if the observer phone dies mid-walk, the sensor keeps measuring and
 *      hands counting back to the person holding it.
 *
 * Camera QR scanning is not covered here; it needs a physical device.
 *
 * Usage: start a local server, then `node tools/remote-e2e.mjs`.
 */
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4173/index.html?qa=remote-e2e';
const PORT = Number(process.env.CDP_PORT || 9335);
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

  async capture(file) {
    if (!process.env.SHOTS_DIR) return;
    // Background tabs freeze CSS animations, which leaves modals captured mid-fade.
    await this.send('Page.bringToFront').catch(() => {});
    await sleep(420);
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: false,
    });
    await mkdir(process.env.SHOTS_DIR, { recursive: true });
    await writeFile(path.join(process.env.SHOTS_DIR, file), Buffer.from(data, 'base64'));
  }

  close() {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

async function waitForEndpoint() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch { /* still starting */ }
    await sleep(250);
  }
  throw new Error('Chrome DevTools endpoint did not become ready');
}

async function openTab() {
  const target = await (await fetch(
    `http://127.0.0.1:${PORT}/json/new?${encodeURIComponent('about:blank')}`,
    { method: 'PUT' },
  )).json();
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
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
  await sleep(900);
  return cdp;
}

async function waitFor(cdp, expression, predicate, label, timeout = 12000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await cdp.evaluate(expression);
    if (predicate(last)) return last;
    await sleep(150);
  }
  throw new Error(`timeout waiting for ${label}: ${JSON.stringify(last)}`);
}

const visibleStep = `([...document.querySelectorAll('.remote-step')].find((el) => !el.hidden) || {}).id || ''`;

/**
 * Renders the on-screen QR into a canvas and decodes it with the vendored jsQR.
 * This proves the pairing QR is actually scannable, without a physical camera.
 */
function decodeQrInPage(containerId) {
  return `(async () => {
    const svg = document.getElementById(${JSON.stringify(containerId)})?.querySelector('svg');
    if (!svg) return { error: 'QR이 렌더링되지 않았습니다' };
    const clone = svg.cloneNode(true);
    clone.setAttribute('width', '720');
    clone.setAttribute('height', '720');
    const xml = new XMLSerializer().serializeToString(clone);
    const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('QR 이미지를 불러오지 못했습니다'));
        img.src = url;
      });
      const size = 720;
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, size, size);
      ctx.drawImage(img, 0, 0, size, size);
      if (!window.jsQR) {
        await new Promise((resolve, reject) => {
          const script = document.createElement('script');
          script.src = './js/vendor/jsqr.min.js';
          script.onload = resolve;
          script.onerror = () => reject(new Error('jsQR를 불러오지 못했습니다'));
          document.head.append(script);
        });
      }
      const frame = ctx.getImageData(0, 0, size, size);
      const found = window.jsQR(frame.data, size, size, { inversionAttempts: 'dontInvert' });
      return { decoded: found?.data || '', viewBox: svg.getAttribute('viewBox') };
    } finally {
      URL.revokeObjectURL(url);
    }
  })()`;
}

async function main() {
  const profileDir = await mkdtemp(path.join(os.tmpdir(), 'stridecare-remote-'));
  const chrome = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    // Headless Chrome advertises only mDNS (.local) host candidates, which never
    // resolve between two tabs in this harness. Real phones resolve mDNS fine;
    // disabling the hiding exposes plain host candidates so ICE can connect here.
    '--disable-features=WebRtcHideLocalIpsWithMdns',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profileDir}`,
    `--user-agent=${MOBILE_UA}`,
    'about:blank',
  ], { stdio: 'ignore' });

  let sensor;
  let observer;
  try {
    await waitForEndpoint();
    sensor = await openTab();
    observer = await openTab();

    const errors = [];
    const watchErrors = (name, cdp) => cdp.on('Runtime.exceptionThrown', (event) => {
      errors.push(`${name}: ${event.exceptionDetails?.exception?.description || 'uncaught exception'}`);
    });
    watchErrors('sensor', sensor);
    watchErrors('observer', observer);

    // Record every raw data-channel payload the observer receives, so we can
    // prove the measuring phone never sends automatic step counts to it.
    const installMessageTap = (cdp) => cdp.evaluate(`(() => {
      window.__scMsgs = [];
      const orig = RTCDataChannel.prototype.addEventListener;
      RTCDataChannel.prototype.addEventListener = function (type, fn, opts) {
        if (type === 'message' && typeof fn === 'function') {
          const wrapped = function (event) {
            try { window.__scMsgs.push(String(event.data)); } catch { /* ignore */ }
            return fn.call(this, event);
          };
          return orig.call(this, type, wrapped, opts);
        }
        return orig.call(this, type, fn, opts);
      };
      return true;
    })()`);

    /** 측정 폰이 offer를 만들고 관찰자 폰이 answer를 돌려주는 실제 UI 흐름. */
    async function pairPhones(shots = false) {
      await sensor.evaluate(`(document.getElementById('remoteEntryBtn').click(), true)`);
      if (shots) {
        await sleep(480);
        await sensor.capture('02-remote-choose.png');
      }
      await sensor.evaluate(`(document.getElementById('roleSensor').click(), true)`);
      const offer = await waitFor(
        sensor,
        `document.getElementById('remoteOfferCode')?.value || ''`,
        (v) => v.length > 200,
        'sensor offer code',
        15000,
      );
      const offerState = await sensor.evaluate(`({
        step: ${visibleStep},
        qr: !!document.querySelector('#remoteQrOffer svg'),
        badge: document.getElementById('remoteEntryBadge')?.textContent,
        copy: !!document.getElementById('remoteCopyOffer'),
      })`);
      if (!offerState.qr) errors.push('sensor: offer QR did not render');
      if (shots) await sensor.capture('03-remote-offer.png');
      const offerQr = await sensor.evaluate(decodeQrInPage('remoteQrOffer'));
      if (offerQr.error) errors.push(`sensor: ${offerQr.error}`);
      else if (offerQr.decoded !== offer) {
        errors.push(`sensor: offer QR decoded to a different code (${offerQr.decoded.length} vs ${offer.length})`);
      }

      await installMessageTap(observer);
      await observer.evaluate(`(async () => {
        document.getElementById('remoteEntryBtn').click();
        await new Promise((r) => setTimeout(r, 120));
        document.getElementById('roleObserver').click();
        await new Promise((r) => setTimeout(r, 120));
        const input = document.getElementById('remoteOfferInput');
        input.value = ${JSON.stringify(offer)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('remoteMakeAnswer').click();
        return true;
      })()`);
      const answer = await waitFor(
        observer,
        `document.getElementById('remoteAnswerCode')?.value || ''`,
        (v) => v.length > 200,
        'observer answer code',
        15000,
      );
      const answerState = await observer.evaluate(`({
        step: ${visibleStep},
        qr: !!document.querySelector('#remoteQrAnswer svg'),
        badge: document.getElementById('remoteEntryBadge')?.textContent,
      })`);
      if (!answerState.qr) errors.push('observer: answer QR did not render');
      if (shots) await observer.capture('04-remote-answer.png');
      const answerQr = await observer.evaluate(decodeQrInPage('remoteQrAnswer'));
      if (answerQr.error) errors.push(`observer: ${answerQr.error}`);
      else if (answerQr.decoded !== answer) {
        errors.push(`observer: answer QR decoded to a different code (${answerQr.decoded.length} vs ${answer.length})`);
      }

      await sensor.evaluate(`(async () => {
        document.getElementById('remoteToAnswer').click();
        await new Promise((r) => setTimeout(r, 120));
        const input = document.getElementById('remoteAnswerInput');
        input.value = ${JSON.stringify(answer)};
        input.dispatchEvent(new Event('input', { bubbles: true }));
        document.getElementById('remoteConnect').click();
        return true;
      })()`);
      await waitFor(sensor, visibleStep, (v) => v === 'remoteStepConnected', 'sensor connected step')
        .catch(async (error) => {
          const diag = await sensor.evaluate(`({
            step: ${visibleStep},
            hint: document.getElementById('remoteAnswerHint')?.textContent,
            cls: document.getElementById('remoteAnswerHint')?.className,
            toast: document.getElementById('toast')?.textContent,
          })`);
          const diagObs = await observer.evaluate(`({
            step: ${visibleStep},
            wait: document.getElementById('remoteWaitText')?.textContent,
            toast: document.getElementById('toast')?.textContent,
          })`);
          throw new Error(`${error.message} :: ${JSON.stringify({ diag, diagObs })}`);
        });

      await waitFor(observer, `document.querySelector('.screen.is-active')?.id || ''`,
        (v) => v === 'screen-observer', 'observer screen');
      await waitFor(observer, `document.getElementById('obsLink')?.textContent || ''`,
        (v) => v === '연결됨', 'observer link chip');
      if (shots) await sensor.capture('05-remote-connected.png');
      return { offer, answer, offerState, answerState, offerQr, answerQr };
    }

    const startDemo = () => sensor.evaluate(`(async () => {
      document.getElementById('startBtn').click();
      await new Promise((r) => setTimeout(r, 200));
      document.getElementById('useDemo').click();
      return true;
    })()`);

    /* ---- 1. pairing through the real UI ---- */
    await sensor.evaluate(`(document.querySelector('.start-extras')?.scrollIntoView({ block: 'center' }), true)`);
    await sleep(260);
    await sensor.capture('01-measure-cards.png');
    await sensor.evaluate(`(window.scrollTo(0, 0), true)`);

    const first = await pairPhones(true);
    const connectedAt = Date.now();
    const sensorConnected = await sensor.evaluate(`({
      badge: document.getElementById('remoteEntryBadge')?.textContent,
      status: document.getElementById('remoteEntryStatus')?.textContent,
      card: document.getElementById('remoteEntryBtn')?.className,
      bodyObserver: document.body.classList.contains('is-observer'),
    })`);

    /* ---- 2. session A: count from the observer ---- */
    await sensor.evaluate(`(document.querySelector('#modalRemote [data-close-remote]').click(), true)`);
    await sleep(150);
    await startDemo();
    await waitFor(observer, `document.getElementById('obsPhase')?.textContent || ''`,
      (v) => v === '측정 중', 'observer running phase');

    // Let the demo signal produce real automatic steps on the measuring phone so
    // the privacy assertions later compare against a non-trivial detected count.
    const detectedSteps = Number(await waitFor(
      sensor,
      `document.getElementById('liveSteps')?.textContent || '0'`,
      (v) => Number(v) >= 3,
      'sensor demo detected steps',
      25000,
    ));
    if (detectedSteps < 3) throw new Error(`demo detected too few steps: ${detectedSteps}`);

    await observer.evaluate(`(async () => {
      const plus = document.getElementById('obsPlus');
      for (let i = 0; i < 12; i++) {
        plus.click();
        await new Promise((r) => setTimeout(r, 60));
      }
      return true;
    })()`);
    const counted = await waitFor(sensor, `document.getElementById('manualCount')?.textContent || ''`,
      (v) => v === '12', 'sensor manual count 12');
    const sensorManual = await sensor.evaluate(`({
      count: document.getElementById('manualCount')?.textContent,
      disabled: document.getElementById('manualBtn')?.disabled,
      tag: !document.getElementById('manualRemoteTag')?.hidden,
      hint: document.getElementById('manualHint')?.textContent,
      sub: document.querySelector('#manualBtn small')?.textContent,
    })`);

    await observer.evaluate(`(document.getElementById('obsMinus').click(), true)`);
    const decremented = await waitFor(sensor, `document.getElementById('manualCount')?.textContent || ''`,
      (v) => v === '11', 'sensor manual count 11');
    await observer.capture('06-observer-running.png');
    await sensor.capture('07-live-remote.png');

    /* ---- 3. pause / resume from the observer ---- */
    await observer.evaluate(`(document.getElementById('obsPause').click(), true)`);
    await waitFor(sensor, `document.getElementById('pauseBtn')?.textContent?.trim() || ''`,
      (v) => v === '계속 측정', 'sensor paused');
    const pausedChip = await sensor.evaluate(`document.getElementById('sensorChip')?.textContent.trim()`);
    const observerPaused = await waitFor(observer, `document.getElementById('obsPhase')?.textContent || ''`,
      (v) => v === '일시정지됨', 'observer paused phase');

    await observer.evaluate(`(document.getElementById('obsPause').click(), true)`);
    await waitFor(sensor, `document.getElementById('pauseBtn')?.textContent?.trim() || ''`,
      (v) => v === '일시정지', 'sensor resumed');

    /* ---- 3b. a healthy link must outlive the 15 s pairing watchdog ---- */
    // acceptAnswer() arms a 15 s timer that returns to step 1 if ICE never
    // connects. Make sure it does not fire on a link that came up normally.
    const elapsedSincePair = Date.now() - connectedAt;
    if (elapsedSincePair < 16500) await sleep(16500 - elapsedSincePair);
    const survivedTimeout = await sensor.evaluate(
      `document.getElementById('remoteEntryBadge')?.textContent || ''`);
    if (survivedTimeout !== '연결됨') {
      errors.push(`sensor: healthy link did not survive the 15 s pairing timeout (${survivedTimeout})`);
    }

    /* ---- 4. stop from the observer ---- */
    await observer.evaluate(`(async () => {
      document.getElementById('obsStop').click();
      await new Promise((r) => setTimeout(r, 250));
      document.getElementById('confirmStop').click();
      return true;
    })()`);
    await waitFor(sensor, `document.querySelector('.screen.is-active')?.id || ''`,
      (v) => v === 'screen-result', 'sensor result screen', 15000);
    const result = await sensor.evaluate(`({
      screen: document.querySelector('.screen.is-active')?.id,
      steps: document.getElementById('resultSteps')?.textContent,
      manual: document.getElementById('manualInput')?.value,
      panelHidden: document.getElementById('manualPanel')?.hidden,
    })`);

    const observerEnded = await waitFor(observer, `document.getElementById('obsPhase')?.textContent || ''`,
      (v) => v === '측정 종료됨', 'observer ended phase', 8000);
    await observer.capture('09-observer-ended.png');
    await sensor.capture('10-result-remote.png');

    const detectedFinal = Number(result.steps);
    const rawMessages = await observer.evaluate(`window.__scMsgs || []`);
    const observerFinal = await observer.evaluate(`({
      phase: document.getElementById('obsPhase')?.textContent,
      count: document.getElementById('obsCount')?.textContent,
      plusDisabled: document.getElementById('obsPlus')?.disabled,
      stopDisabled: document.getElementById('obsStop')?.disabled,
      hintHidden: getComputedStyle(document.querySelector('#obsPlus .obs-tap__hint')).visibility === 'hidden',
      // The detected count must not appear anywhere on the observer screen.
      detectedToken: document.getElementById('screen-observer').innerText
        .split(/\\s+/).includes(${JSON.stringify(String(detectedFinal))}),
      text: document.getElementById('screen-observer').innerText.replace(/\\s+/g, ' ').slice(0, 220),
    })`);

    // The measuring phone must never send automatic step counts over the link.
    const leaked = rawMessages.filter((raw) => {
      try {
        const msg = JSON.parse(raw);
        return ['steps', 'auto', 'detected', 'autoSteps'].some((key) =>
          Object.prototype.hasOwnProperty.call(msg, key));
      } catch {
        return false;
      }
    });
    if (leaked.length) {
      throw new Error(`자동 계수가 관찰자 폰으로 전송되었습니다: ${JSON.stringify(leaked.slice(0, 3))}`);
    }
    if (detectedFinal === Number(observerFinal.count)) {
      throw new Error(`검증 불가: 자동 계수와 관찰자 계수가 같습니다 (${detectedFinal})`);
    }
    if (observerFinal.detectedToken) {
      throw new Error(`관찰자 화면에 자동 계수(${detectedFinal})가 표시되었습니다.`);
    }
    if (!observerFinal.hintHidden) errors.push('observer: tap hint is still visible after the session ended');
    if (Number(result.manual) !== 11) errors.push(`sensor: result manual count is ${result.manual}, expected 11`);

    /* ---- 5. re-pair, start session B, count, then lose the observer phone ---- */
    observer = await openTab();
    watchErrors('observer2', observer);
    const second = await pairPhones();
    await sensor.evaluate(`(document.querySelector('#modalRemote [data-close-remote]').click(), true)`);
    await sleep(150);
    await startDemo();
    const adoptedZero = await waitFor(observer, `document.getElementById('obsCount')?.textContent || ''`,
      (v) => v === '0', 'observer resets for the new session', 10000);
    await waitFor(observer, `document.getElementById('obsPhase')?.textContent || ''`,
      (v) => v === '측정 중', 'observer running phase (session B)');

    await observer.evaluate(`(async () => {
      const plus = document.getElementById('obsPlus');
      for (let i = 0; i < 9; i++) {
        plus.click();
        await new Promise((r) => setTimeout(r, 60));
      }
      return true;
    })()`);
    const countedB = await waitFor(sensor, `document.getElementById('manualCount')?.textContent || ''`,
      (v) => v === '9', 'sensor manual count 9 (session B)');

    // The observer phone dies mid-walk: the sensor must keep measuring and hand
    // counting back to whoever is holding it.
    await observer.send('Page.close').catch(() => {});
    await waitFor(sensor, `document.getElementById('remoteEntryBadge')?.textContent || ''`,
      (v) => v === '끊김', 'sensor mid-session link drop', 15000);
    const midDrop = await sensor.evaluate(`({
      screen: document.querySelector('.screen.is-active')?.id,
      badge: document.getElementById('remoteEntryBadge')?.textContent,
      status: document.getElementById('remoteEntryStatus')?.textContent,
      manualDisabled: document.getElementById('manualBtn')?.disabled,
      tagHidden: document.getElementById('manualRemoteTag')?.hidden,
      hint: document.getElementById('manualHint')?.textContent,
      note: document.getElementById('liveNote')?.textContent,
      pauseLabel: document.getElementById('pauseBtn')?.textContent?.trim(),
      count: document.getElementById('manualCount')?.textContent,
    })`);
    if (midDrop.screen !== 'screen-live') errors.push('sensor: measurement stopped when the observer phone dropped');
    if (midDrop.manualDisabled) errors.push('sensor: local counting not restored after a mid-session drop');
    if (!midDrop.tagHidden) errors.push('sensor: remote tag still shown after a mid-session drop');
    if (!/끊겼/.test(midDrop.note || '')) errors.push('sensor: live screen does not explain the disconnect');
    if (midDrop.count !== '9') errors.push(`sensor: count lost on disconnect (${midDrop.count})`);

    /* ---- 6. finish session B locally ---- */
    await sensor.evaluate(`(async () => {
      document.getElementById('stopBtn').click();
      await new Promise((r) => setTimeout(r, 250));
      document.getElementById('confirmStop').click();
      return true;
    })()`);
    await waitFor(sensor, `document.querySelector('.screen.is-active')?.id || ''`,
      (v) => v === 'screen-result', 'sensor result screen (session B)', 15000);
    const resultB = await sensor.evaluate(`({
      screen: document.querySelector('.screen.is-active')?.id,
      steps: document.getElementById('resultSteps')?.textContent,
      manual: document.getElementById('manualInput')?.value,
    })`);

    if (errors.length) throw new Error(errors.join('\n'));

    console.log('관찰자 리모컨 E2E 통과');
    console.log(JSON.stringify({
      offer: { length: first.offer.length, head: first.offer.slice(0, 8), ...first.offerState },
      answer: { length: first.answer.length, head: first.answer.slice(0, 8), ...first.answerState },
      qrRoundTrip: {
        first: !first.offerQr.error && first.offerQr.decoded === first.offer &&
          !first.answerQr.error && first.answerQr.decoded === first.answer,
        second: !second.offerQr.error && second.offerQr.decoded === second.offer &&
          !second.answerQr.error && second.answerQr.decoded === second.answer,
      },
      sensorConnected,
      counted,
      sensorManual,
      decremented,
      paused: { chip: pausedChip, observer: observerPaused },
      result,
      observerEnded,
      observedMessages: rawMessages.length,
      detectedFinal,
      observerFinal,
      repaired: { adoptedZero, countedB },
      midDrop,
      survivedTimeout,
      resultB,
    }, null, 2));
  } finally {
    sensor?.close();
    observer?.close();
    chrome.kill();
    await sleep(300);
    await rm(profileDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exitCode = 1;
});
