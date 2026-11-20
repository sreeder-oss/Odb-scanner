import { extractPidPayload, hasObdError } from './obd-parser.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const SLOW_COMMANDS = new Set(['ATZ', '0902', '03', '07', '0A', '0100', '0120', '0140']);
const BAUD_RATES = [38400, 115200, 9600, 57600];

// Standard Bluetooth Classic Serial Port Profile (RFCOMM SPP) UUID for Web Serial discovery
export const BLUETOOTH_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';

// Resync timing constants (Web Serial / BT SPP clones often need wider settle windows than BLE)
export const RESYNC_INITIAL_MS = { ble: 400, serial: 650 };
export const RESYNC_QUIET_MS = { ble: 1500, serial: 2000 };
export const RESYNC_MAX_MS = 6000;

export const KNOWN_BLE_SERVICES = [
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '0000ffe0-0000-1000-8000-00805f9b34fb',
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e',
  '000018f0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // ISSC / Microchip transparent UART (Veepeak/Konnwei/Vgate)
  '0000ae00-0000-1000-8000-00805f9b34fb',
  '0000bee0-0000-1000-8000-00805f9b34fb',
  '0000ff00-0000-1000-8000-00805f9b34fb',
  '0000fef5-0000-1000-8000-00805f9b34fb',
];

export async function requestSerialScannerPort() {
  if (!('serial' in navigator)) {
    throw new Error('Web Serial is not supported in this browser. Use Chrome or Edge on desktop over HTTPS (or BLE on Android).');
  }
  try {
    return await navigator.serial.requestPort({
      allowedBluetoothServiceClassIds: [BLUETOOTH_SPP_UUID],
    });
  } catch (err) {
    // Only retry without Bluetooth SPP option if browser rejects the option dictionary itself
    if (err?.name === 'TypeError') {
      return await navigator.serial.requestPort();
    }
    throw err;
  }
}

export async function requestBleScannerDevice() {
  if (!('bluetooth' in navigator)) {
    throw new Error('Web Bluetooth is not supported in this browser. Use Chrome or Edge over HTTPS.');
  }
  return await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: KNOWN_BLE_SERVICES,
  });
}

function getTimeoutFor(cmd, overrideMs) {
  if (typeof overrideMs === 'number') return overrideMs;
  const norm = cmd.replace(/\s+/g, '').toUpperCase();
  if (SLOW_COMMANDS.has(norm)) return 8000;
  return 3000;
}

export const ADAPTER_PROFILES = {
  stn_fast: {
    id: 'stn_fast',
    label: 'Fast STN / OBDLink MX+ adapter',
    interCommandDelayMs: 15,
    minInterCommandDelayMs: 10,
    backoffStepsMs: [15, 40, 80, 150],
    maxDashboardPids: 20,
    minCycleIntervalMs: 0,
    isFastAdapter: true,
    isCloneV13: false,
  },
  elm_clone_v13: {
    id: 'elm_clone_v13',
    label: 'Conservative ELM327 v1.3a / clone profile',
    interCommandDelayMs: 150,
    minInterCommandDelayMs: 100,
    backoffStepsMs: [150, 200, 300],
    maxDashboardPids: 6,
    minCycleIntervalMs: 1000,
    isFastAdapter: false,
    isCloneV13: true,
  },
  elm_standard: {
    id: 'elm_standard',
    label: 'Standard ELM327 profile',
    interCommandDelayMs: 150,
    minInterCommandDelayMs: 100,
    backoffStepsMs: [150, 200, 300],
    maxDashboardPids: 10,
    minCycleIntervalMs: 500,
    isFastAdapter: false,
    isCloneV13: false,
  },
};

export const ERROR_CATEGORY = {
  PROTOCOL: 'PROTOCOL',
  OS_SERIAL: 'OS_SERIAL',
};

const OS_ERROR_NAMES = new Set([
  'NetworkError',
  'NotFoundError',
  'NotReadableError',
  'InvalidStateError',
  'IOException',
  'BluetoothException',
  'SecurityError',
  'BreakError',
  'FramingError',
  'ParityError',
  'BufferOverrunError',
]);

const OS_ERROR_MSG_RE =
  /serial read ended|unknown system error|device has been lost|port.*closed|transport not connected|gatt.*disconnected|socket.*closed|broken pipe|connection reset|detached|usb|ioexception|acl_disconnected|read failure|write failure|framing error|break received|overrun|port dead/i;

export function formatOsErrorDetail(err, info = {}) {
  const name = err?.name || 'Error';
  const code = err?.code !== undefined && err?.code !== null ? ` code=${err.code}` : '';
  const rawMsg = (err?.message || String(err || '')).trim();
  const causeMsg = err?.cause ? ` cause=${err.cause.name || ''}:${err.cause.message || err.cause}` : '';

  const parts = [];
  if (info.transport) parts.push(`transport=${info.transport}`);
  if (info.portInfo) {
    const vid = info.portInfo.usbVendorId !== undefined ? info.portInfo.usbVendorId.toString(16).padStart(4, '0') : null;
    const pid = info.portInfo.usbProductId !== undefined ? info.portInfo.usbProductId.toString(16).padStart(4, '0') : null;
    if (vid || pid) parts.push(`usb=${vid || '????'}:${pid || '????'}`);
    if (info.portInfo.bluetoothServiceClassId) parts.push(`btSvc=${info.portInfo.bluetoothServiceClassId}`);
  }
  if (info.readable !== undefined || info.writable !== undefined) {
    parts.push(`readable=${Boolean(info.readable)} writable=${Boolean(info.writable)}`);
  }
  if (info.bleConnected !== undefined) {
    parts.push(`gattConnected=${Boolean(info.bleConnected)}`);
  }

  const stateStr = parts.length ? ` (${parts.join(', ')})` : '';
  const msgText = rawMsg && !/^unknown system error$/i.test(rawMsg)
    ? rawMsg
    : `${rawMsg || 'I/O failure'} — kernel/driver aborted port I/O`;
  return `[${name}${code}] ${msgText}${causeMsg}${stateStr}`;
}

export function classifyElmError(err, info = {}) {
  if (err?.category === ERROR_CATEGORY.OS_SERIAL || err?.isOsError) {
    return ERROR_CATEGORY.OS_SERIAL;
  }
  const name = err?.name || '';
  const msg = err?.message || String(err || '');
  if (OS_ERROR_NAMES.has(name) || OS_ERROR_MSG_RE.test(msg)) {
    return ERROR_CATEGORY.OS_SERIAL;
  }
  if (info.transport === 'serial' && info.port && (!info.port.readable || !info.port.writable)) {
    return ERROR_CATEGORY.OS_SERIAL;
  }
  if (info.transport === 'ble' && info.bleDevice && !info.bleDevice.gatt?.connected) {
    return ERROR_CATEGORY.OS_SERIAL;
  }
  return ERROR_CATEGORY.PROTOCOL;
}

export function createOsSerialError(err, info = {}) {
  const detail = formatOsErrorDetail(err, info);
  const out = new Error(detail);
  out.name = err?.name || 'OsSerialError';
  out.code = err?.code;
  out.category = ERROR_CATEGORY.OS_SERIAL;
  out.isOsError = true;
  out.osDetail = detail;
  out.originalError = err;
  return out;
}

export function detectAdapterProfile(atiText) {
  const ati = String(atiText || '');
  if (/STN|OBDLINK/i.test(ati)) {
    return { ...ADAPTER_PROFILES.stn_fast };
  }
  if (/v1\.?3|v1\.?4|v1\.?5|ELM327\s*v1/i.test(ati)) {
    return { ...ADAPTER_PROFILES.elm_clone_v13 };
  }
  return { ...ADAPTER_PROFILES.elm_standard };
}

export class Elm327Connection {
  constructor({ onStatus, onLog, onDisconnect, onOsError, txDelayMs } = {}) {
    this.onStatus = onStatus || (() => {});
    this.onLog = onLog || (() => {});
    this.onDisconnect = onDisconnect || (() => {});
    this.onOsError = onOsError || (() => {});

    this.transport = null; // 'serial' | 'ble'
    this._lastConnectType = null;
    this.port = null;
    this.serialPortInfo = null;
    this.activeBaudRate = null;
    this.reader = null;
    this.writer = null;
    this.readLoopActive = false;
    this._readLoopPromise = null;

    this.bleDevice = null;
    this.bleServer = null;
    this.bleWriteChar = null;
    this.bleNotifyChar = null;
    this.bleWriteWithResponse = true;

    this.rxBuffer = '';
    this.lastRxTime = 0;
    this.lastTxTime = 0;
    this.lastPromptTime = 0;
    this.staleFrameCount = 0;
    this._quietPromptWake = null;
    this.pending = null; // { resolve, reject, timer, cmd }
    this.queue = Promise.resolve();

    this.adapterIdentity = '';
    this.protocolNumber = '';
    this.batteryVoltage = '';
    this.adapterProfile = { ...ADAPTER_PROFILES.elm_standard };
    this.configuredDelayMs =
      typeof txDelayMs === 'number' && Number.isFinite(txDelayMs)
        ? Math.max(100, Math.round(txDelayMs))
        : 150;
    this.interCommandDelayMs = this.configuredDelayMs;
    this.isFastAdapter = false; // ATI contains STN / OBDLink
    this.currentHeader = '7DF';
    this.connected = false;
    this.adapterAlive = false;
    this.ecuConnected = false;
    this.initial0100Bytes = null;
    this.initialRpmValue = null;
    this.usedMinimalInit = false;
    this.portDead = false;
    this.detached = false;
    this.consecutiveOsErrors = 0;
    this._closing = false;
    this._probing = false;
    this._probeError = null;

    this._onPortDisconnect = null;
    this._onNavSerialDisconnect = null;
    this._onBleGattDisconnect = null;
  }

  setInterCommandDelay(ms) {
    const minFloor = this.adapterProfile?.minInterCommandDelayMs ?? 100;
    const parsed = Math.max(minFloor, Math.round(Number(ms) || 150));
    this.configuredDelayMs = Math.max(100, parsed);
    this.interCommandDelayMs = parsed;
    return this.interCommandDelayMs;
  }

  log(dir, text) {
    this.onLog({ ts: new Date(), dir, text });
  }

  setStatus(msg, level = 'info') {
    this.onStatus(msg, level);
  }

  // Drain ALL complete '>'-terminated frames in a loop so trailing replies in the same
  // chunk never sit unconsumed in rxBuffer and misalign the next command. The first complete
  // frame resolves this.pending; any extra/unsolicited frames are counted, logged, and discarded,
  // leaving only trailing partial (non-'>') bytes in rxBuffer.
  _handleRxChunk(str) {
    if (!str) return;
    this.lastRxTime = Date.now();
    this.rxBuffer += str;

    let promptIdx;
    while ((promptIdx = this.rxBuffer.indexOf('>')) !== -1) {
      const frame = this.rxBuffer.slice(0, promptIdx);
      this.rxBuffer = this.rxBuffer.slice(promptIdx + 1);
      this.lastPromptTime = Date.now();
      const cleaned = frame.replace(/\r/g, '\n').trim();

      if (this.pending) {
        const active = this.pending;
        this.pending = null;
        clearTimeout(active.timer);
        this.log('RX', cleaned || '(empty)');
        active.resolve(frame);
      } else {
        this.staleFrameCount++;
        if (cleaned) {
          this.log(
            'SYS',
            `WARN: Discarded stale/unsolicited frame #${this.staleFrameCount} with no pending command: "${cleaned}"`
          );
        } else {
          this.log(
            'SYS',
            `WARN: Discarded extra empty '>' prompt frame #${this.staleFrameCount} with no pending command`
          );
        }
      }

      if (this._quietPromptWake) {
        const wake = this._quietPromptWake;
        this._quietPromptWake = null;
        wake();
      }
    }
  }

  _getTransportSnapshot() {
    let portInfo = this.serialPortInfo;
    try {
      if (!portInfo && this.port?.getInfo) {
        portInfo = this.port.getInfo();
      }
    } catch {}
    return {
      transport: this.transport,
      port: this.port,
      portInfo,
      readable: Boolean(this.port?.readable),
      writable: Boolean(this.port?.writable),
      bleDevice: this.bleDevice,
      bleConnected: Boolean(this.bleDevice?.gatt?.connected),
    };
  }

  isPortAlive() {
    if (this._closing || this.portDead || this.detached) return false;
    if (this.transport === 'serial') {
      return Boolean(this.port && this.writer && this.port.readable && this.port.writable);
    }
    if (this.transport === 'ble') {
      return Boolean(this.bleDevice?.gatt?.connected && this.bleWriteChar);
    }
    return false;
  }

  _handleFatalTransportFailure(err, { isDetachEvent = false, source = 'io' } = {}) {
    if (this._closing) return;
    if (isDetachEvent) {
      this.detached = true;
    }

    // During initial baud probing, UART FramingError / BreakError / EOF on a wrong baud rate
    // is expected — reject the active probe command cleanly WITHOUT marking the session dead
    // or firing onOsError / auto-reconnect while _openSerialPortAndNegotiate is still trying bauds.
    if (this._probing && !isDetachEvent) {
      const probeErr = createOsSerialError(err, this._getTransportSnapshot());
      this._probeError = probeErr;
      this.readLoopActive = false;
      this.log('SYS', `Probe I/O error (${source}): ${probeErr.osDetail}`);
      if (this.pending) {
        clearTimeout(this.pending.timer);
        const active = this.pending;
        this.pending = null;
        active.reject(probeErr);
      }
      return;
    }

    const alreadyDead = this.portDead;
    if (!alreadyDead) {
      this.consecutiveOsErrors++;
    }
    this.portDead = true;
    this.connected = false;
    this.readLoopActive = false;

    const osErr = createOsSerialError(err, this._getTransportSnapshot());
    if (!alreadyDead || isDetachEvent) {
      this.log(
        'SYS',
        `OS/SERIAL ${isDetachEvent ? 'DETACH' : 'ERROR'} (${source}, count=${this.consecutiveOsErrors}): ${osErr.osDetail} — stopping resync, port marked dead`
      );
    }

    if (this.pending) {
      clearTimeout(this.pending.timer);
      const active = this.pending;
      this.pending = null;
      active.reject(osErr);
    }

    if (!alreadyDead || isDetachEvent) {
      this.onOsError({
        category: ERROR_CATEGORY.OS_SERIAL,
        isDetachEvent,
        detail: osErr.osDetail,
        error: osErr,
        consecutiveOsErrors: this.consecutiveOsErrors,
      });
    }
  }

  _getResyncTiming() {
    const key = this.transport === 'serial' ? 'serial' : 'ble';
    return {
      initialMs: RESYNC_INITIAL_MS[key],
      quietMs: RESYNC_QUIET_MS[key],
      maxMs: RESYNC_MAX_MS,
    };
  }

  // Wait until EITHER no bytes arrive for quietMs OR a '>' prompt arrives after sinceMs,
  // capped by maxWaitMs (RESYNC_MAX_MS) so noisy/laggy adapters cannot stall recovery.
  async _waitForQuiet(quietMs, { sinceMs = Date.now(), maxWaitMs = RESYNC_MAX_MS } = {}) {
    const { quietMs: defaultQuiet } = this._getResyncTiming();
    const targetQuiet = typeof quietMs === 'number' ? quietMs : defaultQuiet;
    const startMs = Date.now();

    while (!this._closing && !this.portDead && !this.detached) {
      const now = Date.now();
      if (this.lastPromptTime > sinceMs) break;
      if (now - startMs >= maxWaitMs) break;

      const refTime = Math.max(this.lastRxTime || 0, sinceMs);
      const elapsedQuiet = now - refTime;
      if (elapsedQuiet >= targetQuiet) break;

      const remainingQuiet = targetQuiet - elapsedQuiet;
      const remainingMax = maxWaitMs - (now - startMs);
      const waitStep = Math.max(10, Math.min(50, remainingQuiet, remainingMax));
      await new Promise((resolve) => {
        const t = setTimeout(() => {
          if (this._quietPromptWake === wakeFn) this._quietPromptWake = null;
          resolve();
        }, waitStep);
        const wakeFn = () => {
          clearTimeout(t);
          resolve();
        };
        this._quietPromptWake = wakeFn;
      });
    }
    this._quietPromptWake = null;
    this.rxBuffer = '';
  }

  async _writeRaw(cmd, { logTx = true } = {}) {
    if (this.portDead || this.detached || this._closing) {
      throw createOsSerialError(new Error('Port dead — write aborted'), this._getTransportSnapshot());
    }
    const trimmed = cmd.trim();
    const payload = trimmed + '\r';
    const encoded = new TextEncoder().encode(payload);
    if (logTx) {
      this.log('TX', trimmed || '<CR>');
    }

    try {
      if (this.transport === 'serial' && this.writer) {
        await this.writer.write(encoded);
      } else if (this.transport === 'ble' && this.bleWriteChar) {
        // BLE GATT writes chunked at 20 bytes for maximum compatibility with cheap clones
        const chunkSize = 20;
        for (let i = 0; i < encoded.length; i += chunkSize) {
          const slice = encoded.slice(i, i + chunkSize);
          if (this.bleWriteChar.properties.writeWithoutResponse && !this.bleWriteWithResponse) {
            await this.bleWriteChar.writeValueWithoutResponse(slice);
          } else if (this.bleWriteChar.properties.write) {
            await this.bleWriteChar.writeValueWithResponse(slice);
          } else {
            await this.bleWriteChar.writeValueWithoutResponse(slice);
          }
        }
      } else {
        throw createOsSerialError(new Error('Transport not connected'), this._getTransportSnapshot());
      }
    } catch (err) {
      // Clear partial RX bytes on write failure so an aborted TX never desyncs the next reply
      this.rxBuffer = '';
      if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
        this._handleFatalTransportFailure(err, { source: 'write' });
        throw createOsSerialError(err, this._getTransportSnapshot());
      }
      throw err;
    }
  }

  _sendRawQueued(cmd, timeoutMsOverride, { skipDelay = false } = {}) {
    const task = this.queue.then(async () => {
      if (this.portDead || this.detached || this._closing) {
        throw createOsSerialError(new Error('Port dead — command rejected without resync'), this._getTransportSnapshot());
      }

      if (!skipDelay && this.interCommandDelayMs > 0) {
        const lastActivity = Math.max(this.lastPromptTime, this.lastTxTime);
        if (lastActivity > 0) {
          const elapsed = Date.now() - lastActivity;
          if (elapsed < this.interCommandDelayMs) {
            await sleep(this.interCommandDelayMs - elapsed);
          }
        }
      }

      if (this.portDead || this.detached || this._closing) {
        throw createOsSerialError(new Error('Port dead before TX'), this._getTransportSnapshot());
      }

      const timeoutMs = getTimeoutFor(cmd, timeoutMsOverride);
      this.rxBuffer = '';

      return new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          if (!this.pending) return;
          const timedOutCmd = this.pending.cmd;
          this.pending = null;
          if (this.portDead || this.detached || !this.isPortAlive()) {
            const err = createOsSerialError(new Error(`Port died during ${timedOutCmd}`), this._getTransportSnapshot());
            this._handleFatalTransportFailure(err, { source: 'timeoutCheck' });
            reject(err);
            return;
          }
          const { initialMs, maxMs } = this._getResyncTiming();
          const partial = this.rxBuffer.replace(/[\r\n]+/g, ' ').trim();
          const partialNote = partial ? ` (partial rx: "${partial.slice(0, 80)}")` : '';
          this.log('SYS', `PROTOCOL Timeout (${timeoutMs} ms) on "${timedOutCmd}"${partialNote} — waiting up to ${initialMs} ms quiet to resync`);
          try {
            await this._waitForQuiet(initialMs, { sinceMs: Date.now(), maxWaitMs: maxMs });
          } catch {
            // Ignore
          }
          this.lastPromptTime = Date.now();
          const protoErr = new Error(`Timeout waiting for reply to ${timedOutCmd}`);
          protoErr.category = ERROR_CATEGORY.PROTOCOL;
          protoErr.isTimeout = true;
          reject(protoErr);
        }, timeoutMs);

        this.pending = { resolve, reject, timer, cmd };
        this.lastTxTime = Date.now();
        this._writeRaw(cmd).catch((err) => {
          this.rxBuffer = '';
          if (this.pending) {
            clearTimeout(this.pending.timer);
            this.pending = null;
            reject(err);
          }
        });
      });
    });

    // Keep queue chain alive even if individual command rejects
    this.queue = task.catch(() => {});
    return task;
  }

  sendCommand(cmd, timeoutMsOverride) {
    return this._sendRawQueued(cmd, timeoutMsOverride);
  }

  // Safely interrupt an active ELM327 SEARCHING... / BUS INIT sweep without repeating the
  // previous OBD command (sending bare <CR> when already at '>' would re-run 0100; sending ATI
  // interrupts an active search with STOPPED and is harmless if already idle at '>').
  async _abortActiveSearch() {
    if (this.portDead || this.detached || this._closing || !this.isPortAlive()) return;
    const task = this.queue.then(async () => {
      if (this.portDead || this.detached || this._closing || !this.isPortAlive()) return;
      this.log('SYS', 'Interrupting any active ELM327 search (ATI) and draining to prompt…');
      try {
        const sentAt = Date.now();
        this.rxBuffer = '';
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            if (this.pending && this.pending.cmd === 'ATI (abort)') {
              this.pending = null;
            }
            resolve();
          }, 1800);
          this.pending = {
            cmd: 'ATI (abort)',
            timer,
            resolve: () => resolve(),
            reject: () => resolve(),
          };
          this.lastTxTime = sentAt;
          this._writeRaw('ATI', { logTx: false }).catch((err) => {
            clearTimeout(timer);
            if (this.pending && this.pending.cmd === 'ATI (abort)') {
              this.pending = null;
            }
            if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
              this._handleFatalTransportFailure(err, { source: 'abortSearch' });
            }
            resolve();
          });
        });
        await this._waitForQuiet(180, { sinceMs: Date.now(), maxWaitMs: 600 });
      } catch (err) {
        if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
          this._handleFatalTransportFailure(err, { source: 'abortSearch' });
        }
      }
      this.rxBuffer = '';
      this.lastPromptTime = Date.now();
    });
    this.queue = task.catch(() => {});
    return task;
  }

  slowDownPolling(desyncCount = 1) {
    const current = this.interCommandDelayMs;
    let next = current;

    if (this.isFastAdapter) {
      const steps = this.adapterProfile.backoffStepsMs || [15, 40, 80, 150];
      const found = steps.find((ms) => ms > current);
      if (found !== undefined) next = found;
    } else {
      // Exact adaptive rate for ELM327 clones: 1st desync -> 200 ms, 2nd desync -> 300 ms
      const target = desyncCount >= 2 ? 300 : 200;
      if (target > current) {
        next = target;
      } else {
        const steps = this.adapterProfile.backoffStepsMs || [150, 200, 300];
        const found = steps.find((ms) => ms > current);
        if (found !== undefined) next = found;
      }
    }

    if (next !== current) {
      this.interCommandDelayMs = next;
      this.log('SYS', `Adaptive polling (desync #${desyncCount}): inter-command delay ${current} ms -> ${next} ms`);
    }
    return this.interCommandDelayMs;
  }

  _isValidAtiReply(reply) {
    const clean = String(reply || '').replace(/[\r\n>]/g, ' ').trim();
    if (!clean) return false;
    if (/ELM327|STN|OBDLINK|VGATE|ICAR|v\d+\.\d/i.test(clean)) return true;
    if (this.adapterIdentity && clean.toUpperCase().includes(this.adapterIdentity.slice(0, 6).toUpperCase())) {
      return true;
    }
    // Reject pure hex OBD replies (e.g. stale 410F / 4142 frames)
    const compact = clean.replace(/\s+/g, '');
    if (/^[0-9A-Fa-f]{4,}$/.test(compact) && /^4[0-9A-F]/i.test(compact)) {
      return false;
    }
    return clean.length >= 3 && !/NO DATA|ERROR|\?/i.test(clean);
  }

  // Drain stale adapter buffer, flush with CR x3 (or ATFR on STN), and probe ATI to confirm '>' prompt alignment
  async resyncBuffer() {
    if (this.portDead || this.detached || this._closing || this.consecutiveOsErrors >= 2 || !this.isPortAlive()) {
      this.log('SYS', 'Skipping resync — port is dead/detached (switching to reconnect mode)');
      return false;
    }

    const task = this.queue.then(async () => {
      if (this._closing || this.portDead || this.detached || this.consecutiveOsErrors >= 2 || !this.isPortAlive()) {
        return false;
      }
      const { initialMs, quietMs, maxMs } = this._getResyncTiming();
      this.log(
        'SYS',
        this.isFastAdapter
          ? `Flushing adapter buffer (ATFR + drain ${initialMs}/${quietMs}ms + ATI alignment probe)…`
          : `Flushing adapter buffer (CR x3 + drain ${initialMs}/${quietMs}ms + ATI alignment probe)…`
      );
      await this._waitForQuiet(initialMs, { sinceMs: Date.now(), maxWaitMs: maxMs });
      if (this._closing || this.portDead || this.detached) return false;

      const flushSentAt = Date.now();
      try {
        if (this.isFastAdapter) {
          await this._writeRaw('ATFR', { logTx: false });
          await sleep(80);
        } else {
          for (let i = 0; i < 3; i++) {
            await this._writeRaw('', { logTx: false });
            await sleep(75);
          }
        }
      } catch (err) {
        if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
          this._handleFatalTransportFailure(err, { source: 'resyncFlush' });
          return false;
        }
      }

      await this._waitForQuiet(quietMs, { sinceMs: flushSentAt, maxWaitMs: maxMs });
      if (this._closing || this.portDead || this.detached) return false;

      // Probe ATI up to 2 times in case a late OBD frame was still draining
      for (let probeAttempt = 0; probeAttempt < 2; probeAttempt++) {
        if (this.portDead || this.detached || this._closing) return false;
        this.rxBuffer = '';
        try {
          const reply = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
              if (this.pending) {
                this.pending = null;
              }
              const tErr = new Error('Resync ATI timeout');
              tErr.category = ERROR_CATEGORY.PROTOCOL;
              reject(tErr);
            }, 2500);
            this.pending = { resolve, reject, timer, cmd: 'ATI (resync)' };
            this.lastTxTime = Date.now();
            this._writeRaw('ATI').catch((err) => {
              this.rxBuffer = '';
              if (this.pending) {
                clearTimeout(this.pending.timer);
                this.pending = null;
                reject(err);
              }
            });
          });
          const clean = reply.replace(/[\r\n>]/g, ' ').trim();
          if (this._isValidAtiReply(reply)) {
            this.log('SYS', `Resync succeeded (prompt aligned: "${clean}")`);
            this.lastPromptTime = Date.now();
            return true;
          }
          this.log('SYS', `Stale reply during resync probe ("${clean || 'empty'}") — draining before retry…`);
          await this._waitForQuiet(initialMs, { sinceMs: Date.now(), maxWaitMs: maxMs });
        } catch (err) {
          if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
            this._handleFatalTransportFailure(err, { source: 'resyncProbe' });
            return false;
          }
          this.log('SYS', `Resync probe #${probeAttempt + 1} failed: ${err.message}`);
          await this._waitForQuiet(initialMs, { sinceMs: Date.now(), maxWaitMs: maxMs });
          if (probeAttempt === 0) continue;
          return false;
        }
      }

      this.log('SYS', 'Resync probe did not receive valid adapter identity');
      return false;
    });

    this.queue = task.catch(() => false);
    return task;
  }

  _registerSerialDetachListeners(port) {
    this._unregisterSerialDetachListeners();
    this._onPortDisconnect = (ev) => {
      const targetPort = ev?.target || port;
      if (targetPort === this.port) {
        this._handleFatalTransportFailure(
          new Error('USB/Serial device detached (ACTION_USB_DEVICE_DETACHED / Web Serial disconnect)'),
          { isDetachEvent: true, source: 'port.disconnect' }
        );
      }
    };
    this._onNavSerialDisconnect = (ev) => {
      const targetPort = ev?.target;
      if (!targetPort || targetPort === this.port) {
        this._handleFatalTransportFailure(
          new Error('OS Serial port detached (navigator.serial disconnect broadcast)'),
          { isDetachEvent: true, source: 'navigator.serial.disconnect' }
        );
      }
    };
    try {
      port?.addEventListener?.('disconnect', this._onPortDisconnect);
    } catch {}
    try {
      navigator?.serial?.addEventListener?.('disconnect', this._onNavSerialDisconnect);
    } catch {}
  }

  _unregisterSerialDetachListeners() {
    try {
      if (this.port && this._onPortDisconnect) {
        this.port.removeEventListener('disconnect', this._onPortDisconnect);
      }
    } catch {}
    try {
      if (this._onNavSerialDisconnect && navigator?.serial) {
        navigator.serial.removeEventListener('disconnect', this._onNavSerialDisconnect);
      }
    } catch {}
    this._onPortDisconnect = null;
    this._onNavSerialDisconnect = null;
  }

  async _startSerialReadLoop() {
    this.readLoopActive = true;
    const decoder = new TextDecoder('ascii', { fatal: false });
    try {
      while (this.readLoopActive && this.reader) {
        const { value, done } = await this.reader.read();
        if (done) {
          if (this.readLoopActive && !this._closing) {
            const eofErr = new Error('Serial read ended (stream EOF / done=true)');
            eofErr.name = 'IOException';
            this.log('SYS', 'Serial read loop error: ' + eofErr.message);
            this._handleFatalTransportFailure(eofErr, { source: 'readLoopEOF' });
          }
          break;
        }
        if (value) {
          const text = decoder.decode(value, { stream: true });
          this._handleRxChunk(text);
        }
      }
    } catch (err) {
      if (!this._closing) {
        this.log('SYS', 'Serial read loop error: ' + (err?.message || err));
      }
      if (this.readLoopActive && !this._closing) {
        this._handleFatalTransportFailure(err, { source: 'readLoopCatch' });
      }
    }
  }

  async _closeSerialPort({ keepPortRef = true } = {}) {
    this.readLoopActive = false;
    if (this._quietPromptWake) {
      const wake = this._quietPromptWake;
      this._quietPromptWake = null;
      wake();
    }
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const closeErr = createOsSerialError(new Error('Port closed'), this._getTransportSnapshot());
      this.pending.reject(closeErr);
      this.pending = null;
    }

    const reader = this.reader;
    this.reader = null;
    if (reader) {
      try {
        await Promise.race([reader.cancel().catch(() => {}), sleep(500)]);
      } catch {}
      if (this._readLoopPromise) {
        try {
          await Promise.race([this._readLoopPromise.catch(() => {}), sleep(600)]);
        } catch {}
      }
      try {
        reader.releaseLock();
      } catch {}
    }
    this._readLoopPromise = null;

    const writer = this.writer;
    this.writer = null;
    if (writer) {
      try {
        await Promise.race([writer.abort().catch(() => {}), sleep(300)]);
      } catch {}
      try {
        writer.releaseLock();
      } catch {}
    }

    if (this.port && (this.port.readable || this.port.writable)) {
      try {
        await Promise.race([this.port.close().catch(() => {}), sleep(800)]);
      } catch {}
    }

    if (!keepPortRef) {
      this._unregisterSerialDetachListeners();
      this.port = null;
    }
  }

  async _probeAdapterPresenceAtOpenPort() {
    // Wake sleeping ELM327 clones and flush stale RFCOMM/UART prompts with a bare <CR> first
    try {
      await this._writeRaw('', { logTx: false });
    } catch {}
    await sleep(200);
    this.rxBuffer = '';

    // Send ATZ; if a sleeping clone drops/echoes an empty prompt first, retry ATZ once or confirm via ATI
    for (let attempt = 0; attempt < 2; attempt++) {
      const reply = await this.sendCommand('ATZ', 6000);
      const printable = reply.replace(/[^\x20-\x7E]/g, '').trim();
      if (printable.length >= 2 && !/^\?+$/.test(printable)) {
        return { banner: printable, skipInitialAtz: true };
      }
      // Some clones return an empty '>' to ATZ without printing the banner — check ATI before rejecting baud
      try {
        await sleep(300);
        const ati = await this.sendCommand('ATI', 3000);
        const atiClean = ati.replace(/[^\x20-\x7E]/g, '').trim();
        if (atiClean.length >= 2 && !/^\?+$/.test(atiClean)) {
          return { banner: atiClean, skipInitialAtz: true };
        }
      } catch {}
      if (attempt === 0) {
        await sleep(300);
      }
    }
    return null;
  }

  async _openSerialPortAndNegotiate(port, baudCandidates) {
    this.port = port;
    this.transport = 'serial';
    this._lastConnectType = 'serial';
    this.portDead = false;
    this.detached = false;
    this._closing = false;
    this._probing = true;

    try {
      this.serialPortInfo = port.getInfo ? port.getInfo() : null;
    } catch {
      this.serialPortInfo = null;
    }
    this._registerSerialDetachListeners(port);

    // Optional Android WebView native hook for persistent USB permission
    try {
      const bridge = typeof window !== 'undefined' ? (window.BayScopeAndroid || window.Android) : null;
      bridge?.requestPersistentUsbPermission?.();
    } catch {}

    this.setStatus('Talking to the adapter…', 'working');

    // If the picked SerialPort handle is still open from a prior session, close it cleanly first.
    if (port.readable || port.writable) {
      if (port.readable?.locked || port.writable?.locked) {
        this._probing = false;
        this._unregisterSerialDetachListeners();
        this.port = null;
        this.transport = null;
        const lockedMsg = 'That serial port is still locked by an active connection. Tap Cancel, wait 1 second, or refresh the page and try again.';
        this.setStatus(lockedMsg, 'error');
        throw createOsSerialError(new Error(lockedMsg), this._getTransportSnapshot());
      }
      this.log('SYS', 'Serial port handle was already open — closing stale handle before reopening…');
      try {
        await Promise.race([port.close().catch(() => {}), sleep(800)]);
      } catch {}
      await sleep(300);
    }

    let openedAnyBaud = false;
    let foundProbe = null;

    // Retry 38400 once if Bluetooth Classic RFCOMM returns a transient NetworkError on first open
    const tryOpenPort = async (baudRate) => {
      const maxAttempts = baudRate === 38400 ? 2 : 1;
      let lastErr = null;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        if (this.detached || this._closing) return false;
        try {
          if (port.readable || port.writable) {
            await Promise.race([port.close().catch(() => {}), sleep(500)]);
            await sleep(220);
          }
          await port.open({
            baudRate,
            dataBits: 8,
            stopBits: 1,
            parity: 'none',
            flowControl: 'none',
          });
          return true;
        } catch (err) {
          lastErr = err;
          const isTransientRfcomm = err?.name === 'NetworkError' && attempt < maxAttempts;
          const detail = formatOsErrorDetail(err, this._getTransportSnapshot());
          this.log(
            'SYS',
            isTransientRfcomm
              ? `Transient open error at ${baudRate} (${err.name}) — waiting 450 ms for Bluetooth RFCOMM link and retrying…`
              : `Failed to open at ${baudRate}: ${detail}`
          );
          await this._closeSerialPort({ keepPortRef: true });
          await sleep(isTransientRfcomm ? 450 : 220);
        }
      }
      return false;
    };

    for (const baudRate of baudCandidates) {
      if (this.detached || this._closing) break;
      // Reset per-baud state so an error at an earlier baud never poisons subsequent candidates
      this.portDead = false;
      this._probeError = null;
      this.rxBuffer = '';
      this.lastPromptTime = 0;
      this.lastTxTime = 0;
      this.log('SYS', `Probing serial port at ${baudRate} baud…`);
      const opened = await tryOpenPort(baudRate);
      if (!opened) continue;
      openedAnyBaud = true;

      if (!port.readable || !port.writable) {
        this.log('SYS', `Port opened at ${baudRate} baud but readable/writable streams unavailable — retrying`);
        await this._closeSerialPort({ keepPortRef: true });
        await sleep(220);
        continue;
      }

      this.reader = port.readable.getReader();
      this.writer = port.writable.getWriter();
      this.rxBuffer = '';
      this.lastRxTime = Date.now();
      this._readLoopPromise = this._startSerialReadLoop();

      try {
        // Give Bluetooth Classic RFCOMM / USB-serial bridges time to finish link setup before TX
        await sleep(350);
        if (this._probeError || !this.readLoopActive) {
          throw this._probeError || new Error('Read loop stopped during baud settle');
        }
        const found = await this._probeAdapterPresenceAtOpenPort();
        if (found) {
          this.activeBaudRate = baudRate;
          this._probing = false;
          foundProbe = found;
          this.log('SYS', `Accepted ${baudRate} baud (banner: "${found.banner}")`);
          break;
        }
        this.log('SYS', `No printable banner at ${baudRate} baud — closing port`);
      } catch (err) {
        this.log('SYS', `No ATZ reply at ${baudRate} baud (${err.message}) — closing port`);
      }

      await this._closeSerialPort({ keepPortRef: true });
      // Allow OS serial / Bluetooth driver to release the port before reopening at the next baud
      await sleep(220);
    }

    if (foundProbe) {
      try {
        await sleep(1000); // allow clone reset banner to finish settling
        if (this._closing || this.detached) {
          throw new Error('Connection cancelled');
        }
        const result = await this._runInitAndNegotiate({ skipInitialAtz: foundProbe.skipInitialAtz });
        this.consecutiveOsErrors = 0;
        return result;
      } catch (err) {
        await this._closeSerialPort({ keepPortRef: false });
        this.transport = null;
        throw err;
      }
    }

    this._probing = false;
    this._unregisterSerialDetachListeners();
    this.port = null;
    this.transport = null;
    if (this._closing) {
      throw new Error('Connection cancelled');
    }
    this.setStatus('Adapter silent — no reply to ATZ', 'error');
    const hint = openedAnyBaud
      ? 'Adapter silent — no reply to ATZ at 38400, 115200, 9600, or 57600 baud. If Windows shows two Bluetooth COM ports for your scanner, pick the other COM port (Outgoing SPP).'
      : 'Could not open the selected serial port. Close any other OBD app using the port, check Bluetooth pairing, or try the other COM port.';
    throw createOsSerialError(new Error(hint), this._getTransportSnapshot());
  }

  // Requirement 2: Baud fallback that actually probes (38400 -> 115200 -> 9600 -> 57600)
  async connectSerial(preSelectedPort = null) {
    if (!preSelectedPort) {
      this.setStatus('Step 1 of 3 — pick your adapter', 'info');
    }
    const port = preSelectedPort || (await requestSerialScannerPort());
    return await this._openSerialPortAndNegotiate(port, BAUD_RATES);
  }

  async _connectBleDeviceAndNegotiate(device) {
    this.bleDevice = device;
    this.transport = 'ble';
    this._lastConnectType = 'ble';
    this.portDead = false;
    this.detached = false;
    this._closing = false;
    this._probing = true;
    this.setStatus('Talking to the adapter…', 'working');
    this.log('SYS', `Connecting BLE device "${device.name || 'Unnamed ELM327'}"…`);

    if (this._onBleGattDisconnect) {
      try {
        device.removeEventListener('gattserverdisconnected', this._onBleGattDisconnect);
      } catch {}
    }
    this._onBleGattDisconnect = () => {
      if (!this._closing) {
        this._handleFatalTransportFailure(
          new Error('BLE GATT / ACL disconnected (gattserverdisconnected)'),
          { isDetachEvent: true, source: 'ble.gattserverdisconnected' }
        );
      }
    };
    device.addEventListener('gattserverdisconnected', this._onBleGattDisconnect);

    const server = await device.gatt.connect();
    this.bleServer = server;

    const services = await server.getPrimaryServices();
    let writeChar = null;
    let notifyChar = null;
    let fallbackWrite = null;
    let fallbackNotify = null;

    for (const svc of services) {
      let chars = [];
      try {
        chars = await svc.getCharacteristics();
      } catch {
        continue;
      }
      const n = chars.find((c) => c.properties.notify || c.properties.indicate);
      const w = chars.find((c) => c.properties.write || c.properties.writeWithoutResponse);
      if (n && !fallbackNotify) fallbackNotify = n;
      if (w && !fallbackWrite) fallbackWrite = w;
      if (n && w) {
        notifyChar = n;
        writeChar = w;
        break;
      }
    }

    if (!writeChar) writeChar = fallbackWrite;
    if (!notifyChar) notifyChar = fallbackNotify;

    if (!writeChar || !notifyChar) {
      this._probing = false;
      await this.disconnect();
      this.setStatus('Adapter silent — no reply to ATZ', 'error');
      throw new Error('Could not find compatible BLE UART characteristics on this adapter. If this is a Bluetooth Classic ELM327 clone, use "Connect: Classic / USB" instead.');
    }

    this.bleWriteChar = writeChar;
    this.bleNotifyChar = notifyChar;
    this.bleWriteWithResponse = Boolean(writeChar.properties.write);

    const decoder = new TextDecoder('ascii', { fatal: false });
    notifyChar.addEventListener('characteristicvaluechanged', (ev) => {
      const text = decoder.decode(ev.target.value, { stream: true });
      this._handleRxChunk(text);
    });
    await notifyChar.startNotifications();
    this.lastRxTime = Date.now();
    this.log('SYS', `BLE GATT ready (write=${writeChar.uuid.slice(0, 8)}, notify=${notifyChar.uuid.slice(0, 8)})`);

    try {
      this._probing = false;
      await sleep(200);
      const result = await this._runInitAndNegotiate({ skipInitialAtz: false });
      this.consecutiveOsErrors = 0;
      return result;
    } catch (err) {
      this._probing = false;
      if (!this.connected && !this.adapterAlive) {
        await this.disconnect();
      }
      throw err;
    }
  }

  async connectBLE(preSelectedDevice = null) {
    if (!preSelectedDevice) {
      this.setStatus('Step 1 of 3 — pick your adapter', 'info');
    }
    const device = preSelectedDevice || (await requestBleScannerDevice());
    return await this._connectBleDeviceAndNegotiate(device);
  }

  // Cleanly reset active transport and reopen the previous serial port or BLE device
  async reconnect() {
    const mode = this._lastConnectType || this.transport;
    const savedPort = this.port;
    const savedBleDevice = this.bleDevice;
    const savedBaud = this.activeBaudRate;

    this.log('SYS', `Reconnect requested (${mode || 'unknown'}) — resetting transport cleanly…`);
    await this.disconnect();

    this._closing = false;
    this.portDead = false;
    this.detached = false;
    this.consecutiveOsErrors = 0;
    this.rxBuffer = '';
    this.lastPromptTime = 0;
    this.lastTxTime = 0;
    this.queue = Promise.resolve();

    if (mode === 'serial' && savedPort) {
      const baudOrder = savedBaud
        ? [savedBaud, ...BAUD_RATES.filter((b) => b !== savedBaud)]
        : BAUD_RATES;
      return await this._openSerialPortAndNegotiate(savedPort, baudOrder);
    }
    if (mode === 'serial') {
      return await this.connectSerial(null);
    }
    if (mode === 'ble' && savedBleDevice) {
      return await this.connectBLE(savedBleDevice);
    }

    throw new Error('No previous serial port or BLE device available to reconnect.');
  }

  // Requirement 3 & 5: Exact init sequence + two-stage protocol negotiation
  async _runInitAndNegotiate({ skipInitialAtz }) {
    this.setStatus('Talking to the adapter…', 'working');

    if (!skipInitialAtz) {
      try {
        const found = await this._probeAdapterPresenceAtOpenPort();
        if (!found) {
          this.setStatus('Adapter silent — no reply to ATZ', 'error');
          throw new Error('Adapter silent — no reply to ATZ');
        }
        await sleep(1000);
      } catch (err) {
        this.setStatus('Adapter silent — no reply to ATZ', 'error');
        throw err;
      }
    }

    // Defer ATST32 until after ECU lock so slow-waking ECUs get full default bus-init timing.
    const initCmds = ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1'];
    for (const cmd of initCmds) {
      if (this._closing || this.detached) throw new Error('Connection cancelled');
      await this.sendCommand(cmd, 3000);
    }

    // Read ATI, ATRV (port battery voltage), and ATDPN and show them in connection log
    try {
      const ati = await this.sendCommand('ATI', 3000);
      this.adapterIdentity = ati.replace(/[\r\n>]/g, ' ').trim();
      this.adapterProfile = detectAdapterProfile(this.adapterIdentity);
      this.isFastAdapter = this.adapterProfile.isFastAdapter;
      this.interCommandDelayMs = this.isFastAdapter
        ? this.adapterProfile.interCommandDelayMs
        : Math.max(this.adapterProfile.minInterCommandDelayMs, this.configuredDelayMs || this.adapterProfile.interCommandDelayMs);
      this.log(
        'SYS',
        `Adapter Identity (ATI): ${this.adapterIdentity || 'Unknown'} — ${this.adapterProfile.label} (${this.interCommandDelayMs} ms gap, cap ${this.adapterProfile.maxDashboardPids} PIDs)`
      );
    } catch {
      this.adapterIdentity = 'Unknown';
      this.adapterProfile = { ...ADAPTER_PROFILES.elm_clone_v13 };
      this.interCommandDelayMs = Math.max(100, this.configuredDelayMs || this.adapterProfile.interCommandDelayMs);
    }

    try {
      const rv = await this.sendCommand('ATRV', 3000);
      this.batteryVoltage = rv.replace(/[\r\n>]/g, ' ').trim();
      if (this.batteryVoltage) {
        this.log('SYS', `OBD-II Port Voltage (ATRV): ${this.batteryVoltage}`);
      }
    } catch {
      this.batteryVoltage = '';
    }

    try {
      const dpn = await this.sendCommand('ATDPN', 3000);
      this.protocolNumber = dpn.replace(/[\r\n>]/g, ' ').trim();
      this.log('SYS', `Initial Protocol Number (ATDPN): ${this.protocolNumber || 'Auto'}`);
    } catch {
      this.protocolNumber = '0';
    }

    this.adapterAlive = true;
    return await this.negotiateVehicleProtocol({ skipStandardInit: true });
  }

  // Two-stage ECU negotiation callable on initial connect OR from Adapter-Only Terminal retry.
  // Stage A: Fast standard CAN 500k (ATSP6/ATSP7 with 0100).
  // Stage B: Minimal-init recovery (ATD -> ATE0, spaced 01 00 and direct 01 0C RPM unlock).
  async negotiateVehicleProtocol({ skipStandardInit = false } = {}) {
    if (this.portDead || this.detached || this._closing || !this.isPortAlive()) {
      throw createOsSerialError(new Error('Port is closed — connect adapter first'), this._getTransportSnapshot());
    }

    this.initial0100Bytes = null;
    this.initialRpmValue = null;
    this.usedMinimalInit = false;

    const tryProbeCmd = async (label, cmdToSend, expectedPidHex, minBytes, timeoutMs) => {
      this.log('SYS', `Protocol negotiation: ${label} -> sending ${cmdToSend} (${Math.round(timeoutMs / 1000)}s timeout)`);
      try {
        const resp = await this.sendCommand(cmdToSend, timeoutMs);
        if (hasObdError(resp)) {
          this.log('SYS', `${label} ${cmdToSend} failed: ${resp.trim()}`);
          return null;
        }
        const payload = extractPidPayload(resp, expectedPidHex);
        if (payload && payload.length >= minBytes) {
          this.log('SYS', `${label} succeeded — valid ${expectedPidHex} reply parsed`);
          return payload;
        }
        this.log('SYS', `${label} returned unexpected data (no valid ${expectedPidHex} payload)`);
        return null;
      } catch (err) {
        if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
          throw err;
        }
        this.log('SYS', `${label} failed: ${err.message}`);
        if (err?.isTimeout || /timeout/i.test(err?.message || '')) {
          await this._abortActiveSearch();
        }
        return null;
      }
    };

    const setProtocolSafe = async (spCmd) => {
      try {
        await this.sendCommand(spCmd, 3000);
        return true;
      } catch (err) {
        if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) {
          throw err;
        }
        this.log('SYS', `Failed to set ${spCmd}: ${err.message}`);
        return false;
      }
    };

    if (!skipStandardInit) {
      const initCmds = ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1'];
      for (const cmd of initCmds) {
        if (this._closing || this.detached) throw new Error('Connection cancelled');
        await this.sendCommand(cmd, 3000);
      }
    }

    let pid0100Bytes = null;
    let directRpm = null;
    let usedMinimalInit = false;

    // Stage A: Fast CAN 500k direct lock (locks in <500ms on 2008+ vehicles)
    const stageACandidates = [
      { spCmd: 'ATSP6', shortLabel: 'CAN 11/500', label: 'ATSP6 (ISO 15765-4 CAN 11-bit 500k)', timeoutMs: 5000 },
      { spCmd: 'ATSP7', shortLabel: 'CAN 29/500', label: 'ATSP7 (ISO 15765-4 CAN 29-bit 500k)', timeoutMs: 5000 },
    ];

    for (const cand of stageACandidates) {
      if (this.portDead || this.detached || this._closing) {
        throw createOsSerialError(new Error('Port closed during protocol negotiation'), this._getTransportSnapshot());
      }
      this.setStatus(`Looking for your car — trying ${cand.shortLabel} (key must be ON)…`, 'working');
      if (!(await setProtocolSafe(cand.spCmd))) continue;
      pid0100Bytes = await tryProbeCmd(cand.label, '0100', '0100', 4, cand.timeoutMs);
      if (pid0100Bytes) break;
    }

    // Stage B: Minimal-init recovery for quirky ELM327 v1.3a clones (ATD -> ATE0 without
    // redundant ATZ reset, default spaces ON, spaced "01 00" and direct "01 0C" RPM unlock).
    if (!pid0100Bytes && !this.portDead && !this.detached && !this._closing) {
      usedMinimalInit = true;
      this.setStatus('Trying minimal-init recovery (ATD + spaced 01 00 / 01 0C)…', 'working');
      this.log('SYS', 'Stage A received no ECU reply — starting Stage B minimal-init recovery (ATD -> ATE0, spaced 01 00 & direct 01 0C)…');

      for (const cmd of ['ATD', 'ATE0']) {
        if (this._closing || this.detached) throw new Error('Connection cancelled');
        try {
          await this.sendCommand(cmd, 3000);
        } catch (err) {
          if (classifyElmError(err, this._getTransportSnapshot()) === ERROR_CATEGORY.OS_SERIAL) throw err;
        }
      }

      const stageBCandidates = [
        { spCmd: 'ATSP0', shortLabel: 'Auto search (minimal)', label: 'Minimal ATSP0 (Auto)', timeoutMs: 18000, tryRpm: true },
        { spCmd: 'ATSP6', shortLabel: 'CAN 11/500 (minimal)', label: 'Minimal ATSP6 (CAN 11/500)', timeoutMs: 6000, tryRpm: true },
        { spCmd: 'ATSP7', shortLabel: 'CAN 29/500 (minimal)', label: 'Minimal ATSP7 (CAN 29/500)', timeoutMs: 6000, tryRpm: false },
        { spCmd: 'ATSP3', shortLabel: 'ISO 9141-2 (minimal)', label: 'Minimal ATSP3 (ISO 9141-2)', timeoutMs: 10000, tryRpm: false },
        { spCmd: 'ATSP5', shortLabel: 'KWP fast (minimal)', label: 'Minimal ATSP5 (KWP fast)', timeoutMs: 8000, tryRpm: false },
      ];

      for (const cand of stageBCandidates) {
        if (this.portDead || this.detached || this._closing) {
          throw createOsSerialError(new Error('Port closed during minimal-init recovery'), this._getTransportSnapshot());
        }
        this.setStatus(`Minimal-init recovery — trying ${cand.shortLabel}…`, 'working');
        if (!(await setProtocolSafe(cand.spCmd))) continue;

        pid0100Bytes = await tryProbeCmd(cand.label, '01 00', '0100', 4, cand.timeoutMs);
        if (pid0100Bytes) break;

        if (cand.tryRpm && !this.portDead && !this.detached && !this._closing) {
          const rpmBytes = await tryProbeCmd(`${cand.label} direct RPM`, '01 0C', '010C', 2, Math.min(cand.timeoutMs, 6000));
          if (rpmBytes && rpmBytes.length >= 2) {
            directRpm = (rpmBytes[0] * 256 + rpmBytes[1]) / 4;
            this.log('SYS', `Direct 01 0C RPM unlock succeeded (${Math.round(directRpm)} RPM)!`);
            break;
          }
        }
      }
    }

    if (!pid0100Bytes && directRpm === null) {
      // Adapter IS alive and responding to AT commands — keep port open for Terminal diagnostic mode!
      this.connected = false;
      this.ecuConnected = false;
      this.adapterAlive = true;
      const voltNote = this.batteryVoltage ? ` (${this.batteryVoltage})` : '';
      this.setStatus(`Adapter ready${voltNote}, car ECU silent — open Terminal Log to test commands`, 'warn');
      this.log(
        'SYS',
        `Adapter is responding (${this.adapterIdentity || 'ELM327'}${voltNote}), but the car ECU did not reply on any protocol. Keeping adapter open in Terminal Log mode.`
      );
      return { ok: false, adapterAlive: true, initial0100Bytes: null, initialRpmValue: null, usedMinimalInit };
    }

    // Only apply ATST32 when Stage A succeeded; leave Stage B factory defaults untouched on quirky clones
    if (!usedMinimalInit) {
      try {
        await this.sendCommand('ATST32', 3000);
      } catch {
        // Non-fatal on adapters that ignore ATST
      }
    }

    try {
      const dpn = await this.sendCommand('ATDPN', 3000);
      this.protocolNumber = dpn.replace(/[\r\n>]/g, ' ').trim();
      this.log('SYS', `Active Protocol (ATDPN): ${this.protocolNumber}`);
    } catch {}

    this.connected = true;
    this.ecuConnected = true;
    this.adapterAlive = true;
    this.portDead = false;
    this.initial0100Bytes = pid0100Bytes;
    this.initialRpmValue = directRpm;
    this.usedMinimalInit = usedMinimalInit;

    return {
      ok: true,
      adapterAlive: true,
      initial0100Bytes: pid0100Bytes,
      initialRpmValue: directRpm,
      usedMinimalInit,
    };
  }

  async ensureHeader(headerHex) {
    const target = (headerHex || '7DF').toUpperCase();
    if (this.currentHeader === target) return;
    await this.sendCommand(`ATSH${target}`, 3000);
    this.currentHeader = target;
  }

  async disconnect() {
    this._closing = true;
    this.connected = false;
    this.ecuConnected = false;
    this.adapterAlive = false;
    this._probing = false;
    if (this._quietPromptWake) {
      const wake = this._quietPromptWake;
      this._quietPromptWake = null;
      wake();
    }
    if (this.transport === 'serial') {
      await this._closeSerialPort({ keepPortRef: false });
    } else if (this.transport === 'ble') {
      if (this.pending) {
        clearTimeout(this.pending.timer);
        this.pending.reject(new Error('Disconnected'));
        this.pending = null;
      }
      if (this.bleDevice && this._onBleGattDisconnect) {
        try {
          this.bleDevice.removeEventListener('gattserverdisconnected', this._onBleGattDisconnect);
        } catch {}
        this._onBleGattDisconnect = null;
      }
      try {
        if (this.bleNotifyChar) await this.bleNotifyChar.stopNotifications().catch(() => {});
      } catch {}
      try {
        if (this.bleDevice?.gatt?.connected) this.bleDevice.gatt.disconnect();
      } catch {}
      this.bleDevice = null;
      this.bleServer = null;
      this.bleWriteChar = null;
      this.bleNotifyChar = null;
    }
    this.port = null;
    this.transport = null;
    this.rxBuffer = '';
    this.lastPromptTime = 0;
    this.lastTxTime = 0;
    this.queue = Promise.resolve();
    this.currentHeader = '7DF';
  }
}
