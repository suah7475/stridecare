/**
 * StrideCare — QR 표시 / 카메라 스캔
 *
 * 두 폰 사이에서만 연결 코드를 주고받습니다. 카메라 영상은
 * 기기 밖으로 나가지 않으며 어디에도 저장하지 않습니다.
 */

const JSQR_SRC = './js/vendor/jsqr.min.js';

/** 연결 코드를 QR로 그립니다. 너무 길어 QR 한 장에 담기지 않으면 false. */
export function renderQr(container, text) {
  if (!container) return false;
  if (typeof window.qrcode !== 'function') return false;
  try {
    const qr = window.qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const svg = container.querySelector('svg');
    if (svg) {
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-label', '연결 코드 QR');
    }
    return true;
  } catch {
    container.replaceChildren();
    return false;
  }
}

let decoderPromise = null;

function loadDecoder() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  if (!decoderPromise) {
    decoderPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = JSQR_SRC;
      script.async = true;
      script.addEventListener('load', () => {
        if (typeof window.jsQR === 'function') resolve(window.jsQR);
        else reject(new Error('QR 스캔 모듈을 불러오지 못했습니다.'));
      });
      script.addEventListener('error', () => reject(new Error('QR 스캔 모듈을 불러오지 못했습니다.')));
      document.head.append(script);
    }).catch((error) => {
      decoderPromise = null;
      throw error;
    });
  }
  return decoderPromise;
}

export function scannerSupported() {
  return !!navigator.mediaDevices?.getUserMedia;
}

/**
 * 카메라를 열고 QR을 찾을 때까지 프레임을 검사합니다.
 * 반환된 객체의 stop()으로 카메라를 반드시 꺼야 합니다.
 */
export async function startScanner({ video, canvas, onResult }) {
  if (!scannerSupported()) {
    throw new Error('이 브라우저에서는 카메라를 사용할 수 없습니다. 연결 코드를 직접 입력해 주세요.');
  }
  const decode = await loadDecoder();

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (error) {
    const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    throw new Error(denied
      ? '카메라 권한이 거부되었습니다. 브라우저 설정에서 허용하거나 연결 코드를 직접 입력해 주세요.'
      : '카메라를 열 수 없습니다. 연결 코드를 직접 입력해 주세요.');
  }

  video.srcObject = stream;
  video.muted = true;
  video.setAttribute('playsinline', '');
  try { await video.play(); } catch { /* iOS는 사용자 제스처 후 재생됩니다. */ }

  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  let raf = 0;
  let stopped = false;

  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  };

  const tick = () => {
    if (stopped) return;
    if (video.readyState >= 2 && video.videoWidth) {
      const w = video.videoWidth;
      const h = video.videoHeight;
      const scale = Math.min(1, 720 / Math.max(w, h));
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = decode(frame.data, frame.width, frame.height, { inversionAttempts: 'dontInvert' });
      if (found?.data) {
        stop();
        onResult(found.data);
        return;
      }
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return { stop };
}
