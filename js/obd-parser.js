// ELM327 frame cleaning, ISO-TP multi-frame assembly, Mode 01/03/07/0A/09 decoders.

const NOISE_PREFIXES = [
  'SEARCHING',
  'BUS INIT',
  'OK',
  '?',
  'STOPPED',
  'LV RESET',
  'ACT ALERT',
  'LP ALERT',
];

const ERROR_TOKENS = [
  'NO DATA',
  'UNABLE TO CONNECT',
  'CAN ERROR',
  'BUS ERROR',
  'DATA ERROR',
  'FB ERROR',
  'BUFFER FULL',
  'ERROR',
];

export function hasObdError(raw) {
  const upper = String(raw || '').toUpperCase();
  return ERROR_TOKENS.some((err) => upper.includes(err));
}

export function cleanLines(raw) {
  return String(raw || '')
    .replace(/\r/g, '\n')
    .replace(/>/g, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      const upper = line.toUpperCase();
      if (NOISE_PREFIXES.some((p) => upper.startsWith(p))) return false;
      if (ERROR_TOKENS.some((e) => upper === e || upper.startsWith(e))) return false;
      return true;
    });
}

function parseHexLineToBytes(line) {
  let trimmed = String(line || '').trim();
  // Strip optional 11-bit CAN header (e.g. "7E8 06 41 00 ...") or 29-bit CAN header ("18DAF110 06 41 00 ...")
  const can11 = trimmed.match(/^([0-9A-Fa-f]{3})\s+(.+)$/);
  if (can11 && can11[1].length === 3) {
    trimmed = can11[2];
  } else {
    const can29 = trimmed.match(/^([0-9A-Fa-f]{8})\s+(.+)$/);
    if (can29) {
      trimmed = can29[2];
    }
  }
  const cleaned = trimmed.replace(/[^0-9A-Fa-f]/g, '');
  if (cleaned.length < 2 || cleaned.length % 2 !== 0) return null;
  const out = [];
  for (let i = 0; i < cleaned.length; i += 2) {
    out.push(parseInt(cleaned.slice(i, i + 2), 16));
  }
  return out;
}

// Reassemble ISO-TP multi-frame responses like:
//   0: 49 02 01 31 4A 54
//   1: 45 55 31 31 41 37 30
// Or raw concatenated hex lines.
export function assembleLines(raw) {
  const lines = cleanLines(raw);
  const frameEntries = [];
  const plainLines = [];

  for (const line of lines) {
    const frameMatch = line.match(/^([0-9A-Fa-f]{1,2})\s*:\s*(.+)$/);
    if (frameMatch) {
      const idx = parseInt(frameMatch[1], 16);
      const bytes = parseHexLineToBytes(frameMatch[2]);
      if (bytes) {
        frameEntries.push({ idx, bytes });
      }
    } else {
      const bytes = parseHexLineToBytes(line);
      if (bytes) plainLines.push(bytes);
    }
  }

  if (frameEntries.length > 0) {
    // Group sequential frames starting at index 0
    const groups = [];
    let current = [];
    for (const entry of frameEntries) {
      if (entry.idx === 0 && current.length > 0) {
        groups.push(current);
        current = [];
      }
      current.push(...entry.bytes);
    }
    if (current.length > 0) groups.push(current);
    return [...groups, ...plainLines];
  }

  return plainLines;
}

// Inspect an OBD-II reply and classify whether it matches the requested PID,
// is a lagged/desynced reply for a different PID, or is NO DATA / invalid.
export function inspectObdReply(raw, requestHex) {
  if (!raw) return { status: 'invalid', bytes: null };
  if (hasObdError(raw)) return { status: 'no_data', bytes: null };

  const req = requestHex.replace(/\s+/g, '').toUpperCase();
  if (req.length < 2 || req.length % 2 !== 0) return { status: 'invalid', bytes: null };

  const service = parseInt(req.slice(0, 2), 16);
  const expectedRespService = (service + 0x40) & 0xff;
  const subBytes = [];
  for (let i = 2; i < req.length; i += 2) {
    subBytes.push(parseInt(req.slice(i, i + 2), 16));
  }

  const byteArrays = assembleLines(raw);
  let mismatchedReplyHex = null;

  for (const arr of byteArrays) {
    const candidates = [arr];
    if (arr.length > 2 && arr[0] < 0x10 && arr[1] === expectedRespService) {
      candidates.push(arr.slice(1));
    }

    for (const bytes of candidates) {
      if (bytes[0] !== expectedRespService) {
        // Check if another OBD-II / UDS service reply arrived out of order (0x41..0x6F covers Modes 01..2F)
        if (bytes[0] >= 0x41 && bytes[0] <= 0x6f) {
          mismatchedReplyHex = bytes
            .slice(0, Math.min(2, bytes.length))
            .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
            .join('');
        }
        continue;
      }
      if (bytes.length < 1 + subBytes.length) continue;
      let matched = true;
      for (let j = 0; j < subBytes.length; j++) {
        if (bytes[1 + j] !== subBytes[j]) {
          matched = false;
          break;
        }
      }
      if (matched) {
        return { status: 'ok', bytes: bytes.slice(1 + subBytes.length) };
      }
      mismatchedReplyHex = bytes
        .slice(0, 1 + subBytes.length)
        .map((b) => b.toString(16).toUpperCase().padStart(2, '0'))
        .join('');
    }
  }

  if (mismatchedReplyHex) {
    const expectedRespHex =
      expectedRespService.toString(16).toUpperCase().padStart(2, '0') + req.slice(2);
    return {
      status: 'desync',
      bytes: null,
      expectedPid: req,
      expectedReply: expectedRespHex,
      receivedReply: mismatchedReplyHex,
    };
  }

  return { status: 'invalid', bytes: null };
}

// Extract data bytes for a specific OBD-II request hex (e.g. "010C", "0100", "2101")
export function extractPidPayload(raw, requestHex) {
  const inspected = inspectObdReply(raw, requestHex);
  return inspected.status === 'ok' ? inspected.bytes : null;
}

export function decodeSupportedBitmask(bytes, basePid) {
  if (!bytes || bytes.length < 4) {
    return { supported: [], hasNextBlock: false };
  }
  const supported = [];
  const baseOffset = basePid & 0xff;
  for (let byteIdx = 0; byteIdx < 4; byteIdx++) {
    const val = bytes[byteIdx];
    for (let bit = 7; bit >= 0; bit--) {
      const pidOffset = byteIdx * 8 + (7 - bit) + 1;
      const pidNum = baseOffset + pidOffset;
      const isSet = ((val >> bit) & 1) === 1;
      if (isSet && pidOffset < 32) {
        supported.push('01' + pidNum.toString(16).toUpperCase().padStart(2, '0'));
      }
    }
  }
  const hasNextBlock = (bytes[3] & 0x01) === 1;
  return { supported, hasNextBlock };
}

// Parse Mode 01 PID 01 (MIL status, DTC count, Readiness monitors)
export function parseMode0101(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const A = bytes[0];
  const B = bytes[1];
  const C = bytes[2];
  const D = bytes[3];

  const milOn = (A & 0x80) !== 0;
  const dtcCount = A & 0x7f;
  const isDiesel = (B & 0x08) !== 0;

  const monitors = [
    { name: 'Misfire', supported: (B & 0x01) !== 0, ready: (B & 0x10) === 0 },
    { name: 'Fuel System', supported: (B & 0x02) !== 0, ready: (B & 0x20) === 0 },
    { name: 'Components', supported: (B & 0x04) !== 0, ready: (B & 0x40) === 0 },
  ];

  const nonCont = isDiesel
    ? [
        ['NMHC Catalyst', 0],
        ['NOx / SCR', 1],
        ['Boost Pressure', 3],
        ['Exhaust Gas Sensor', 5],
        ['PM Filter', 6],
        ['EGR / VVT System', 7],
      ]
    : [
        ['Catalyst', 0],
        ['Heated Catalyst', 1],
        ['Evap System', 2],
        ['Secondary Air', 3],
        ['O2 Sensor', 5],
        ['O2 Sensor Heater', 6],
        ['EGR / VVT System', 7],
      ];

  for (const [label, bit] of nonCont) {
    monitors.push({
      name: label,
      supported: ((C >> bit) & 1) === 1,
      ready: ((D >> bit) & 1) === 0,
    });
  }

  return {
    milOn,
    dtcCount,
    ignitionType: isDiesel ? 'Compression (Diesel)' : 'Spark (Gasoline / Hybrid)',
    monitors: monitors.filter((m) => m.supported),
  };
}

// Decode VIN (Mode 09 PID 02)
const WMI_MAKES = {
  JT: 'Toyota / Lexus',
  '1T': 'Toyota',
  '2T': 'Toyota',
  '4T': 'Toyota',
  '5T': 'Toyota',
  JN: 'Nissan / Infiniti',
  '1N': 'Nissan',
  '3N': 'Nissan',
  '5N': 'Nissan / Infiniti / Hyundai',
  '5N1': 'Nissan',
  '5N3': 'Infiniti',
  '5NM': 'Hyundai',
  '5NP': 'Hyundai',
  '1H': 'Honda / Acura',
  '2H': 'Honda / Acura',
  '5J': 'Honda',
  JH: 'Honda / Acura',
  '1F': 'Ford',
  '2F': 'Ford',
  '3F': 'Ford',
  '1G': 'General Motors',
  '2G': 'General Motors',
  '3G': 'General Motors',
  '1C': 'Chrysler / Jeep / Dodge',
  '2C': 'Chrysler / Dodge',
  '3C': 'Chrysler / Ram',
  KM: 'Hyundai',
  KN: 'Kia',
  JM: 'Mazda',
  JF: 'Subaru',
  '4S': 'Subaru',
  WB: 'BMW',
  WA: 'Audi',
  WV: 'Volkswagen',
  WD: 'Mercedes-Benz',
  YV: 'Volvo',
  '5Y': 'Tesla',
  '7S': 'Rivian / Tesla',
};

const YEAR_CODES = {
  T: 1996, V: 1997, W: 1998, X: 1999, Y: 2000,
  1: 2001, 2: 2002, 3: 2003, 4: 2004, 5: 2005, 6: 2006, 7: 2007, 8: 2008, 9: 2009,
  A: 2010, B: 2011, C: 2012, D: 2013, E: 2014, F: 2015, G: 2016, H: 2017, J: 2018,
  K: 2019, L: 2020, M: 2021, N: 2022, P: 2023, R: 2024, S: 2025,
};

export function decodeVinMetadata(vin) {
  if (!vin || vin.length !== 17) return { make: null, year: null };
  const wmi3 = vin.slice(0, 3);
  const wmi2 = vin.slice(0, 2);
  const make = WMI_MAKES[wmi3] || WMI_MAKES[wmi2] || null;
  const yearChar = vin[9];
  const year = YEAR_CODES[yearChar] || null;
  return { make, year };
}

export function parseVinResponse(raw) {
  if (!raw || hasObdError(raw)) return null;
  const byteArrays = assembleLines(raw);
  for (const arr of byteArrays) {
    // Find 49 02 sequence (possibly preceded by ISO-TP length byte)
    let start = -1;
    for (let i = 0; i < arr.length - 2; i++) {
      if (arr[i] === 0x49 && arr[i + 1] === 0x02) {
        start = i + 2;
        break;
      }
    }
    if (start === -1) continue;
    let payload = arr.slice(start);
    // Optional message count byte (01) before ASCII VIN
    if (payload.length >= 18 && payload[0] <= 0x05) {
      payload = payload.slice(1);
    }
    // Strip leading zero padding (ISO 9141 pads 4 bytes with 0x00)
    const asciiBytes = payload.filter((b) => b >= 0x30 && b <= 0x5a);
    const candidate = String.fromCharCode(...asciiBytes).replace(/[^A-HJ-NPR-Z0-9]/g, '');
    if (candidate.length >= 17) {
      const vin = candidate.slice(0, 17);
      const meta = decodeVinMetadata(vin);
      return { vin, ...meta };
    }
  }
  return null;
}

// Parse Stored (03 -> 43), Pending (07 -> 47), Permanent (0A -> 4A) DTCs
const DTC_PREFIX = ['P', 'C', 'B', 'U'];

export function decodeDtcPair(b1, b2) {
  if (b1 === 0 && b2 === 0) return null;
  const prefix = DTC_PREFIX[(b1 >> 6) & 0x03];
  const d1 = ((b1 >> 4) & 0x03).toString(16).toUpperCase();
  const d2 = (b1 & 0x0f).toString(16).toUpperCase();
  const d3 = ((b2 >> 4) & 0x0f).toString(16).toUpperCase();
  const d4 = (b2 & 0x0f).toString(16).toUpperCase();
  const code = `${prefix}${d1}${d2}${d3}${d4}`;
  return code === 'P0000' ? null : code;
}

export function parseDtcResponse(raw, modeHex) {
  if (!raw || hasObdError(raw)) return [];
  const service = parseInt(modeHex, 16);
  const respService = (service + 0x40) & 0xff;
  const byteArrays = assembleLines(raw);
  const found = new Set();

  for (const arr of byteArrays) {
    let payload = null;
    if (arr[0] === respService) {
      payload = arr.slice(1);
    } else if (arr.length > 2 && arr[0] < 0x10 && arr[1] === respService) {
      payload = arr.slice(2);
    } else {
      continue;
    }

    if (payload.length === 0) continue;

    // CAN (ISO 15765-4) prepends a DTC count byte: e.g. [02, 01, 71, 03, 00]
    // Legacy ISO 9141 / KWP returns 6 bytes directly (3 DTCs padded with 00 00)
    let dtcBytes = payload;
    if (payload.length % 2 === 1) {
      dtcBytes = payload.slice(1);
    } else if (payload[0] * 2 === payload.length - 1) {
      dtcBytes = payload.slice(1);
    }

    for (let i = 0; i + 1 < dtcBytes.length; i += 2) {
      const code = decodeDtcPair(dtcBytes[i], dtcBytes[i + 1]);
      if (code) found.add(code);
    }
  }
  return Array.from(found);
}
