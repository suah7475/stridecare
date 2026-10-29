/**
 * StrideCare — 관찰자 리모컨 링크
 *
 * 서버 없이 두 대의 폰을 WebRTC 데이터 채널로 직접 연결합니다.
 * 연결 코드(offer/answer)는 QR 또는 복사·붙여넣기로만 교환하며,
 * 측정 데이터는 어느 서버에도 저장·전송되지 않습니다.
 *
 * 같은 Wi-Fi(같은 서브넷)에 있는 두 기기에서만 연결됩니다.
 * STUN/TURN 서버를 사용하지 않으므로 외부로 IP가 노출되지 않습니다.
 */

const PREFIX = { offer: 'SC1O.', answer: 'SC1A.' };
const HEARTBEAT_MS = 3000;
const STALE_MS = 11000;

export function remoteSupported() {
  return typeof window !== 'undefined' && typeof window.RTCPeerConnection === 'function';
}

/* ------------------------------------------------------------------ */
/* 연결 코드 인코딩                                                     */
/* ------------------------------------------------------------------ */

function b64urlFromBytes(bytes) {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + step));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesFromB64url(str) {
  const pad = str.length % 4 === 0 ? '' : '='.repeat(4 - (str.length % 4));
  const b64 = str.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// SDP에서 실제 연결에 필요한 줄만 남깁니다. 코드 길이가 QR 크기를 좌우합니다.
const KEEP_LINE = /^(v=|o=|s=|t=|c=|m=|a=group:|a=mid:|a=ice-ufrag:|a=ice-pwd:|a=fingerprint:|a=setup:|a=sctp-port:|a=max-message-size:|a=candidate:|a=end-of-candidates|a=ice-options:)/;

export function trimSdp(sdp) {
  return String(sdp || '')
    .split(/\r?\n/)
    .filter((line) => KEEP_LINE.test(line))
    .join('\r\n') + '\r\n';
}

export function hasCandidate(sdp) {
  return /^a=candidate:/m.test(String(sdp || ''));
}

export function encodeSignal(kind, sdp) {
  const prefix = PREFIX[kind];
  if (!prefix) throw new Error('알 수 없는 연결 코드 종류입니다.');
  return prefix + b64urlFromBytes(new TextEncoder().encode(trimSdp(sdp)));
}

export function decodeSignal(code) {
  const clean = String(code || '').replace(/\s+/g, '');
  let kind = null;
  if (clean.startsWith(PREFIX.offer)) kind = 'offer';
  else if (clean.startsWith(PREFIX.answer)) kind = 'answer';
  if (!kind) {
    throw new Error('연결 코드를 인식할 수 없습니다. 코드 전체를 다시 붙여넣어 주세요.');
  }
  let sdp = '';
  try {
    sdp = new TextDecoder().decode(bytesFromB64url(clean.slice(PREFIX.offer.length)));
  } catch {
    throw new Error('연결 코드가 손상되었습니다. 다시 복사해 주세요.');
  }
  if (!sdp.startsWith('v=') || !sdp.includes('m=application')) {
    throw new Error('연결 코드가 손상되었습니다. 다시 복사해 주세요.');
  }
  return { kind, sdp };
}

/* ------------------------------------------------------------------ */
/* 전송 계층                                                           */
/* ------------------------------------------------------------------ */

function waitForGathering(pc, timeout = 5000) {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') finish();
    };
    const timer = setTimeout(finish, timeout);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

export class RemoteLink extends EventTarget {
  constructor(role) {
    super();
    this.role = role; // 'sensor' | 'observer'
    this.pc = null;
    this.dc = null;
    this.closed = false;
    this.lastSeen = 0;
    this.hbTimer = null;
  }

  get isOpen() {
    return this.dc?.readyState === 'open';
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  _newPc() {
    const pc = new RTCPeerConnection({ iceServers: [], iceCandidatePoolSize: 0 });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        this._fail(pc.connectionState);
      }
    });
    return pc;
  }

  _bindChannel(dc) {
    this.dc = dc;
    dc.addEventListener('open', () => {
      this.lastSeen = Date.now();
      this._startHeartbeat();
      this._emit('open');
    });
    dc.addEventListener('close', () => this._fail('channel-closed'));
    dc.addEventListener('error', () => this._fail('channel-error'));
    dc.addEventListener('message', (event) => this._onMessage(event.data));
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object') return;
    this.lastSeen = Date.now();
    if (msg.t === 'hb') return;
    this._emit('message', msg);
  }

  _startHeartbeat() {
    clearInterval(this.hbTimer);
    this.hbTimer = setInterval(() => {
      if (this.closed) return;
      if (Date.now() - this.lastSeen > STALE_MS) {
        this._fail('timeout');
        return;
      }
      this.send({ t: 'hb' });
    }, HEARTBEAT_MS);
  }

  _fail(reason) {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.hbTimer);
    try { this.dc?.close(); } catch { /* ignore */ }
    try { this.pc?.close(); } catch { /* ignore */ }
    this._emit('close', { reason });
  }

  send(msg) {
    if (!this.isOpen) return false;
    try {
      this.dc.send(JSON.stringify(msg));
      return true;
    } catch {
      return false;
    }
  }

  async createOffer() {
    this.pc = this._newPc();
    this._bindChannel(this.pc.createDataChannel('stridecare', { ordered: true }));
    await this.pc.setLocalDescription(await this.pc.createOffer());
    await waitForGathering(this.pc);
    const sdp = this.pc.localDescription?.sdp || '';
    if (!hasCandidate(sdp)) {
      throw new Error('네트워크 주소를 찾지 못했습니다. Wi-Fi에 연결한 뒤 다시 시도하세요.');
    }
    return encodeSignal('offer', sdp);
  }

  async acceptOffer(code) {
    const { kind, sdp } = decodeSignal(code);
    if (kind !== 'offer') throw new Error('측정 폰의 코드가 아닙니다.');
    if (!hasCandidate(sdp)) {
      throw new Error('측정 폰이 네트워크 주소를 찾지 못했습니다. Wi-Fi 연결을 확인하세요.');
    }
    this.pc = this._newPc();
    this.pc.addEventListener('datachannel', (event) => this._bindChannel(event.channel));
    await this.pc.setRemoteDescription({ type: 'offer', sdp });
    await this.pc.setLocalDescription(await this.pc.createAnswer());
    await waitForGathering(this.pc);
    const local = this.pc.localDescription?.sdp || '';
    if (!hasCandidate(local)) {
      throw new Error('네트워크 주소를 찾지 못했습니다. Wi-Fi에 연결한 뒤 다시 시도하세요.');
    }
    return encodeSignal('answer', local);
  }

  async acceptAnswer(code) {
    const { kind, sdp } = decodeSignal(code);
    if (kind !== 'answer') throw new Error('관찰자 폰의 코드가 아닙니다.');
    if (!this.pc) throw new Error('연결이 만료되었습니다. 코드를 다시 만들어 주세요.');
    if (!hasCandidate(sdp)) {
      throw new Error('관찰자 폰이 네트워크 주소를 찾지 못했습니다. Wi-Fi 연결을 확인하세요.');
    }
    await this.pc.setRemoteDescription({ type: 'answer', sdp });
  }

  close() {
    this._fail('local');
  }
}
