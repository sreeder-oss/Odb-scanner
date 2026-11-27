// Zero-dependency client-side QR Code SVG generator (ISO/IEC 18004, Byte Mode, ECC Level L, Versions 1..10).
// Generates QR codes 100% locally in the browser — API keys are NEVER sent to any external QR service.

// Capacities for Byte Mode at Error Correction Level L (Versions 1..10)
// [version, totalCodewords, ecCodewordsPerBlock, numBlocks, maxByteLength, alignmentCenters]
const VERSION_TABLE = [
  null,
  { v: 1, total: 26, ecPerBlock: 7, blocks: 1, maxBytes: 17, align: [] },
  { v: 2, total: 44, ecPerBlock: 10, blocks: 1, maxBytes: 32, align: [6, 18] },
  { v: 3, total: 70, ecPerBlock: 15, blocks: 1, maxBytes: 53, align: [6, 22] },
  { v: 4, total: 100, ecPerBlock: 20, blocks: 1, maxBytes: 78, align: [6, 26] },
  { v: 5, total: 134, ecPerBlock: 26, blocks: 1, maxBytes: 106, align: [6, 30] },
  { v: 6, total: 172, ecPerBlock: 18, blocks: 2, maxBytes: 134, align: [6, 34] },
  { v: 7, total: 196, ecPerBlock: 20, blocks: 2, maxBytes: 154, align: [6, 22, 38] },
  { v: 8, total: 242, ecPerBlock: 24, blocks: 2, maxBytes: 192, align: [6, 24, 42] },
  { v: 9, total: 292, ecPerBlock: 30, blocks: 2, maxBytes: 230, align: [6, 26, 46] },
  { v: 10, total: 346, ecPerBlock: 18, blocks: 4, maxBytes: 271, align: [6, 28, 50] },
];

// GF(256) log/exp tables with primitive polynomial 0x11d
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const next = new Uint8Array(poly.length + 1);
    const root = GF_EXP[i];
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], root);
    }
    poly = next;
  }
  return poly;
}

function rsEncode(dataBytes, ecLen) {
  const gen = rsGeneratorPoly(ecLen);
  const rem = new Uint8Array(ecLen);
  for (let i = 0; i < dataBytes.length; i++) {
    const factor = dataBytes[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecLen - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecLen; j++) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return rem;
}

function encodeDataCodewords(utf8Bytes, spec) {
  const dataCapacity = spec.total - spec.ecPerBlock * spec.blocks;
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i--) {
      bits.push((val >>> i) & 1);
    }
  };

  // Mode indicator: Byte mode = 0100
  pushBits(0b0100, 4);
  // Character count indicator: 8 bits for V1..9, 16 bits for V10+
  pushBits(utf8Bytes.length, spec.v <= 9 ? 8 : 16);
  for (const b of utf8Bytes) {
    pushBits(b, 8);
  }

  // Terminator (up to 4 zero bits)
  const maxBits = dataCapacity * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);

  // Pad to byte boundary
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const codewords = new Uint8Array(dataCapacity);
  let byteIdx = 0;
  for (let i = 0; i < bits.length; i += 8) {
    let b = 0;
    for (let j = 0; j < 8; j++) b = (b << 1) | bits[i + j];
    codewords[byteIdx++] = b;
  }

  // Pad codewords alternating 0xEC, 0x11
  let padToggle = 0;
  while (byteIdx < dataCapacity) {
    codewords[byteIdx++] = padToggle === 0 ? 0xec : 0x11;
    padToggle ^= 1;
  }

  // Split into blocks (Version 10 L has 2 blocks of 68 data bytes + 2 blocks of 69 data bytes)
  const numBlocks = spec.blocks;
  const shortBlockLen = Math.floor(dataCapacity / numBlocks);
  const numLongBlocks = dataCapacity % numBlocks;
  const numShortBlocks = numBlocks - numLongBlocks;

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  for (let b = 0; b < numBlocks; b++) {
    const len = b < numShortBlocks ? shortBlockLen : shortBlockLen + 1;
    const slice = codewords.slice(offset, offset + len);
    offset += len;
    dataBlocks.push(slice);
    ecBlocks.push(rsEncode(slice, spec.ecPerBlock));
  }

  // Interleave data blocks, then EC blocks
  const out = [];
  const maxDataLen = shortBlockLen + (numLongBlocks > 0 ? 1 : 0);
  for (let i = 0; i < maxDataLen; i++) {
    for (let b = 0; b < numBlocks; b++) {
      if (i < dataBlocks[b].length) out.push(dataBlocks[b][i]);
    }
  }
  for (let i = 0; i < spec.ecPerBlock; i++) {
    for (let b = 0; b < numBlocks; b++) {
      out.push(ecBlocks[b][i]);
    }
  }
  return out;
}

function createMatrix(spec, allCodewords) {
  const size = spec.v * 4 + 17;
  const modules = Array.from({ length: size }, () => new Uint8Array(size));
  const isFunc = Array.from({ length: size }, () => new Uint8Array(size));

  const setFunctionModule = (r, c, dark) => {
    if (r < 0 || r >= size || c < 0 || c >= size) return;
    modules[r][c] = dark ? 1 : 0;
    isFunc[r][c] = 1;
  };

  // Finder patterns + separators
  const drawFinder = (topR, leftC) => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const r = topR + dr;
        const c = leftC + dc;
        if (r < 0 || r >= size || c < 0 || c >= size) continue;
        const inOuter = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 && (dr === 0 || dr === 6 || dc === 0 || dc === 6);
        const inInner = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4;
        setFunctionModule(r, c, inOuter || inInner);
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, size - 7);
  drawFinder(size - 7, 0);

  // Timing patterns
  for (let i = 8; i < size - 8; i++) {
    setFunctionModule(6, i, i % 2 === 0);
    setFunctionModule(i, 6, i % 2 === 0);
  }

  // Alignment patterns
  const align = spec.align;
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if (
        (i === 0 && j === 0) ||
        (i === 0 && j === align.length - 1) ||
        (i === align.length - 1 && j === 0)
      ) {
        continue;
      }
      const cr = align[i];
      const cc = align[j];
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const dist = Math.max(Math.abs(dr), Math.abs(dc));
          setFunctionModule(cr + dr, cc + dc, dist !== 1);
        }
      }
    }
  }

  // Dark module & reserved format areas
  setFunctionModule(4 * spec.v + 9, 8, true);
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      if (!isFunc[8][i]) setFunctionModule(8, i, false);
      if (!isFunc[i][8]) setFunctionModule(i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    if (!isFunc[8][size - 1 - i]) setFunctionModule(8, size - 1 - i, false);
    if (!isFunc[size - 1 - i][8]) setFunctionModule(size - 1 - i, 8, false);
  }

  // Version info for v >= 7
  if (spec.v >= 7) {
    let rem = spec.v;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const vBits = (spec.v << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const bit = ((vBits >>> i) & 1) === 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      setFunctionModule(b, a, bit);
      setFunctionModule(a, b, bit);
    }
  }

  // Place data bits in upward/downward 2-column zig-zag
  let bitIdx = 0;
  const totalBits = allCodewords.length * 8;
  let upward = true;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // skip vertical timing column
    for (let vert = 0; vert < size; vert++) {
      const r = upward ? size - 1 - vert : vert;
      for (let j = 0; j < 2; j++) {
        const c = right - j;
        if (!isFunc[r][c]) {
          let dark = false;
          if (bitIdx < totalBits) {
            dark = ((allCodewords[bitIdx >>> 3] >>> (7 - (bitIdx & 7))) & 1) === 1;
            bitIdx++;
          }
          modules[r][c] = dark ? 1 : 0;
        }
      }
    }
    upward = !upward;
  }

  // Write format bits for ECC Level L (01) + Mask
  const writeFormatBits = (targetModules, mask) => {
    const data = (0b01 << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;

    const getBit = (idx) => ((bits >>> idx) & 1) === 1;

    for (let i = 0; i <= 5; i++) targetModules[i][8] = getBit(i) ? 1 : 0;
    targetModules[7][8] = getBit(6) ? 1 : 0;
    targetModules[8][8] = getBit(7) ? 1 : 0;
    targetModules[8][7] = getBit(8) ? 1 : 0;
    for (let i = 9; i < 15; i++) targetModules[8][14 - i] = getBit(i) ? 1 : 0;

    for (let i = 0; i < 8; i++) targetModules[8][size - 1 - i] = getBit(i) ? 1 : 0;
    for (let i = 8; i < 15; i++) targetModules[size - 15 + i][8] = getBit(i) ? 1 : 0;
    targetModules[size - 8][8] = 1;
  };

  const maskTest = (mask, r, c) => {
    switch (mask) {
      case 0: return (r + c) % 2 === 0;
      case 1: return r % 2 === 0;
      case 2: return c % 3 === 0;
      case 3: return (r + c) % 3 === 0;
      case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
      case 5: return ((r * c) % 2) + ((r * c) % 3) === 0;
      case 6: return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
      default: return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
    }
  };

  const scoreMatrix = (m) => {
    let penalty = 0;
    for (let r = 0; r < size; r++) {
      let runColor = m[r][0];
      let runLen = 1;
      for (let c = 1; c < size; c++) {
        if (m[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = m[r][c];
          runLen = 1;
        }
      }
    }
    for (let c = 0; c < size; c++) {
      let runColor = m[0][c];
      let runLen = 1;
      for (let r = 1; r < size; r++) {
        if (m[r][c] === runColor) {
          runLen++;
          if (runLen === 5) penalty += 3;
          else if (runLen > 5) penalty += 1;
        } else {
          runColor = m[r][c];
          runLen = 1;
        }
      }
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) penalty += 3;
      }
    }
    return penalty;
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMatrix = null;

  for (let mask = 0; mask < 8; mask++) {
    const candidate = modules.map((row) => new Uint8Array(row));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!isFunc[r][c] && maskTest(mask, r, c)) {
          candidate[r][c] ^= 1;
        }
      }
    }
    writeFormatBits(candidate, mask);
    const sc = scoreMatrix(candidate);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = mask;
      bestMatrix = candidate;
    }
  }

  return { size, matrix: bestMatrix, mask: bestMask };
}

export function renderQrCodeSvg(text, { margin = 3, pixelSize = 240 } = {}) {
  const utf8 = new TextEncoder().encode(String(text || ''));
  const spec = VERSION_TABLE.find((entry) => entry && utf8.length <= entry.maxBytes);
  if (!spec) {
    throw new Error('Link is too long to encode into a compact QR code (max 271 bytes). Use "Copy pairing link" instead.');
  }

  const codewords = encodeDataCodewords(utf8, spec);
  const { size, matrix } = createMatrix(spec, codewords);
  const total = size + margin * 2;

  const rects = [];
  for (let r = 0; r < size; r++) {
    let c = 0;
    while (c < size) {
      if (matrix[r][c]) {
        let w = 1;
        while (c + w < size && matrix[r][c + w]) w++;
        rects.push(`<rect x="${c + margin}" y="${r + margin}" width="${w}" height="1"/>`);
        c += w;
      } else {
        c++;
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${pixelSize}" height="${pixelSize}" shape-rendering="crispEdges" role="img" aria-label="QR code to transfer API key to phone"><rect width="100%" height="100%" fill="#ffffff"/><g fill="#000000">${rects.join('')}</g></svg>`;
}
