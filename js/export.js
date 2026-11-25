// CSV Export (#-commented diagnostic header + per-row samples + event column),
// Mid-Session PID Health & Stale-Read Tracker,
// Local CSV Pre-Summarizer + Marked-Moment Window Extractor (±8s),
// AI-sized downsampling (~1-2 Hz, capped at 600 rows, preserving marked events),
// Baseline comparisons, and AI Diagnosis Prompt Builder.

// Slow-moving or steady-state PIDs where consecutive identical values are normal
// (temperatures, baro, fuel level, learned LTFT, battery voltage, hybrid SOC, run-time counters).
const SLOW_MOVING_PIDS = new Set([
  '0103', // Fuel System Status
  '0105', // Engine Coolant Temp
  '0107', // LTFT B1
  '0109', // LTFT B2
  '010F', // Intake Air Temp
  '011F', // Run Time
  '0121', // Distance With MIL On
  '012F', // Fuel Tank Level
  '0130', // Warm-ups Since Cleared
  '0131', // Distance Since Cleared
  '0133', // Barometric Pressure
  '013C', // Catalyst Temp B1S1
  '013D', // Catalyst Temp B2S1
  '013E', // Catalyst Temp B1S2
  '013F', // Catalyst Temp B2S2
  '0142', // Control Module Voltage
  '0144', // Commanded Equivalence Ratio
  '0146', // Ambient Air Temp
  '014D', // Time Run With MIL On
  '014E', // Time Since Cleared
  '015B', // Hybrid Battery Pack SOC
  '015C', // Engine Oil Temp
]);

function roundTo(val, decimals = 2) {
  if (val === null || val === undefined || !Number.isFinite(val)) return null;
  const factor = 10 ** Math.max(0, decimals);
  return Math.round(val * factor) / factor;
}

export function isSlowMovingPid(pidHex) {
  return SLOW_MOVING_PIDS.has(String(pidHex || '').toUpperCase());
}

/**
 * 1. Mid-Session PID Health & Stale-Read Tracker
 * Tracks per-PID hit rate, timeouts, NO DATA responses, and suspiciously frozen values
 * (while ignoring expected steady states such as 0 RPM / 0 km/h when parked or slow-moving thermal PIDs).
 */
export function createPidHealthTracker({ staleThreshold = 12 } = {}) {
  const stats = new Map();

  function getEntry(pid) {
    if (!stats.has(pid)) {
      stats.set(pid, {
        attempts: 0,
        ok: 0,
        timeouts: 0,
        noData: 0,
        desyncs: 0,
        lastValue: undefined,
        consecutiveSame: 0,
        staleEpisodes: [],
        lastOkSec: null,
      });
    }
    return stats.get(pid);
  }

  return {
    /**
     * Call after each PID poll attempt.
     * status: "ok" | "timeout" | "no_data" | "desync" | "error"
     */
    record({ pid, status, value = null, elapsedSec = 0, ignoreStale = false }) {
      if (!pid) return;
      const entry = getEntry(pid);
      entry.attempts += 1;

      if (status !== 'ok') {
        if (status === 'timeout') entry.timeouts += 1;
        else if (status === 'desync') entry.desyncs += 1;
        else entry.noData += 1;
        return;
      }

      entry.ok += 1;
      entry.lastOkSec = roundTo(elapsedSec, 1);

      // Avoid false stale alarms when parked/KOEO (0 RPM or 0 km/h) or on slow-changing thermal/state PIDs
      const isParkedZero =
        (pid === '010C' && value === 0) ||
        (pid === '010D' && value === 0);
      const shouldIgnoreStale = Boolean(ignoreStale || isSlowMovingPid(pid) || isParkedZero);

      if (!shouldIgnoreStale && value !== null && Number.isFinite(value) && value === entry.lastValue) {
        entry.consecutiveSame += 1;
        if (entry.consecutiveSame === staleThreshold) {
          entry.staleEpisodes.push({
            atSec: Math.round(elapsedSec),
            value: roundTo(value, 2),
          });
        }
      } else {
        entry.consecutiveSame = 0;
        entry.lastValue = value;
      }
    },

    reset() {
      stats.clear();
    },

    /** Returns structured summary per PID */
    summarize() {
      const out = {};
      for (const [pid, s] of stats.entries()) {
        const hitRate = s.attempts ? Math.round((s.ok / s.attempts) * 100) : 0;
        out[pid] = {
          attempts: s.attempts,
          ok: s.ok,
          hitRate,
          timeouts: s.timeouts,
          noData: s.noData,
          desyncs: s.desyncs,
          staleEpisodes: s.staleEpisodes,
          lastOkSec: s.lastOkSec,
        };
      }
      return out;
    },

    /** Formats a plain-English telemetry health summary (used in CSV `#` header and AI context) */
    toSummaryString(pidMap = null) {
      const summary = this.summarize();
      const entries = Object.entries(summary).filter(([, s]) => s.attempts > 0);
      if (entries.length === 0) {
        return 'all active PIDs steady';
      }

      const notes = [];
      for (const [pid, s] of entries) {
        const label = pidMap?.get(pid)?.shortName ? `${pidMap.get(pid).shortName}(${pid})` : pid;
        if (s.ok === 0) {
          notes.push(`${label} 0% hit (unimplemented/no response)`);
          continue;
        }
        if (s.hitRate < 85 || s.timeouts > 0) {
          notes.push(`${label} ${s.hitRate}% hit (${s.timeouts} timeouts, ${s.noData} NO DATA)`);
        }
        if (s.staleEpisodes.length > 0) {
          const first = s.staleEpisodes[0];
          notes.push(`${label} stale x${s.staleEpisodes.length} (stuck at ${first.value} from ${first.atSec}s)`);
        }
      }

      return notes.length > 0 ? notes.join('; ') : 'all active PIDs steady';
    },

    /** Formats a single `#` CSV header comment flagging only anomalies */
    toCsvHeaderLine(pidMap = null) {
      return `# Telemetry health: ${this.toSummaryString(pidMap)}`;
    },
  };
}

function escapeCsvCell(val) {
  if (val === null || val === undefined || val === '') return '';
  const str = String(val);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function computeSessionStats(records, pidIds, pidMap) {
  const stats = [];
  for (const pidId of pidIds) {
    const meta = pidMap.get(pidId);
    if (!meta) continue;
    let count = 0;
    let sum = 0;
    let min = Infinity;
    let max = -Infinity;
    let first = null;
    let last = null;
    for (const row of records) {
      const v = row.values[pidId];
      if (v !== null && v !== undefined && Number.isFinite(v)) {
        if (first === null) first = v;
        last = v;
        count++;
        sum += v;
        if (v < min) min = v;
        if (v > max) max = v;
      }
    }
    if (count > 0) {
      stats.push({
        pidHex: pidId,
        name: meta.name,
        shortName: meta.shortName,
        unit: meta.unit,
        decimals: meta.decimals,
        count,
        first,
        last,
        min,
        avg: sum / count,
        max,
      });
    }
  }
  return stats;
}

/**
 * 2. Local CSV Pre-Summarizer + Marked-Moment Window Extractor (±8s)
 * Slices tight context windows around every user-marked moment (always preserving the marked row itself)
 * so DeepSeek / Claude / Gemini can inspect second-by-second dynamics around shudders or symptoms.
 */
export function extractMarkedMomentWindows(
  records,
  pidIds,
  pidMap,
  { windowBeforeSec = 8, windowAfterSec = 8, maxRowsPerWindow = 40 } = {}
) {
  if (!Array.isArray(records) || records.length === 0) return [];
  const t0 = records[0].ts;

  const activePids = (pidIds || []).filter((id) => {
    if (!pidMap?.has(id)) return false;
    return records.some((r) => {
      const v = r.values?.[id];
      return v !== null && v !== undefined && Number.isFinite(v);
    });
  });

  const markers = [];
  for (let i = 0; i < records.length; i++) {
    const ev = records[i]?.event;
    if (ev && String(ev).trim() !== '') {
      markers.push({
        index: i,
        atSec: roundTo((records[i].ts - t0) / 1000, 1),
        label: String(ev).trim(),
      });
    }
  }

  if (markers.length === 0) return [];

  const pidColumns = activePids.map((id) => {
    const meta = pidMap.get(id);
    return {
      id,
      header: meta ? `${meta.shortName} (${meta.unit})` : id,
      decimals: meta?.decimals ?? 1,
    };
  });

  return markers.map((marker) => {
    const startSec = Math.max(0, roundTo(marker.atSec - windowBeforeSec, 1));
    const endSec = roundTo(marker.atSec + windowAfterSec, 1);

    let slice = records.filter((r) => {
      const elapsed = (r.ts - t0) / 1000;
      return elapsed >= marker.atSec - windowBeforeSec && elapsed <= marker.atSec + windowAfterSec;
    });

    // Downsample if polling rate was very fast, while ALWAYS keeping any row with a marked event
    if (slice.length > maxRowsPerWindow) {
      const step = Math.ceil(slice.length / maxRowsPerWindow);
      slice = slice.filter((r, idx) => idx % step === 0 || (r.event && String(r.event).trim() !== ''));
    }

    const csvHeader = ['elapsed_s', 'event', ...pidColumns.map((c) => c.header)]
      .map(escapeCsvCell)
      .join(',');

    const csvRows = [];
    const structuredRows = [];

    for (const r of slice) {
      const elapsedNum = roundTo((r.ts - t0) / 1000, 2);
      const evText = r.event ? String(r.event).trim() : '';
      const rowObj = { elapsed_s: elapsedNum };
      if (evText) rowObj.event = evText;

      const valCells = pidColumns.map((col) => {
        const raw = r.values?.[col.id];
        if (raw === null || raw === undefined || !Number.isFinite(raw)) return '';
        const formatted = Number(raw.toFixed(col.decimals));
        rowObj[col.id] = formatted;
        return raw.toFixed(col.decimals);
      });

      structuredRows.push(rowObj);
      csvRows.push([elapsedNum.toFixed(2), evText, ...valCells].map(escapeCsvCell).join(','));
    }

    return {
      marker: marker.label,
      atSec: marker.atSec,
      window: `${startSec}s-${endSec}s`,
      rowCount: slice.length,
      csvBlock: `${csvHeader}\n${csvRows.join('\n')}`,
      rows: structuredRows,
    };
  });
}

export function buildAiDiagnosticPayload({
  records,
  recordedPidIds,
  pidMap,
  headerLines = [],
  windowBeforeSec = 8,
  windowAfterSec = 8,
  maxRowsPerWindow = 40,
}) {
  if (!records || records.length === 0) {
    return { stats: [], eventWindows: [], summaryText: 'No telemetry rows recorded.' };
  }

  const stats = computeSessionStats(records, recordedPidIds, pidMap);
  const eventWindows = extractMarkedMomentWindows(records, recordedPidIds, pidMap, {
    windowBeforeSec,
    windowAfterSec,
    maxRowsPerWindow,
  });

  const durationSec =
    records.length > 1
      ? roundTo((records[records.length - 1].ts - records[0].ts) / 1000, 1)
      : 0;

  const statLines = stats.map(
    (s) =>
      `- ${s.name} (${s.pidHex}, ${s.unit}): start=${s.first.toFixed(s.decimals)}, end=${s.last.toFixed(s.decimals)}, min=${s.min.toFixed(s.decimals)}, avg=${s.avg.toFixed(s.decimals)}, max=${s.max.toFixed(s.decimals)} (n=${s.count})`
  );

  const windowLines = eventWindows.length
    ? eventWindows.map(
        (w) => `### Event: "${w.marker}" @ ${w.atSec}s (${w.window})\n\`\`\`csv\n${w.csvBlock}\n\`\`\``
      )
    : ['No marked moments recorded during drive.'];

  const summaryText = [
    ...headerLines,
    `# Session duration: ${durationSec}s (${records.length} total samples)`,
    '',
    '## Whole-Drive Summary',
    ...statLines,
    '',
    '## Marked Moments (Context Windows)',
    ...windowLines,
  ].join('\n');

  return { stats, eventWindows, summaryText };
}

export function downsampleRecordsForAi(records, { targetHz = 1.5, maxRows = 600 } = {}) {
  if (!Array.isArray(records) || records.length === 0) return [];
  if (records.length <= 2) return [...records];

  const t0 = records[0].ts;
  const tEnd = records[records.length - 1].ts;
  const totalSpanMs = Math.max(1, tEnd - t0);

  const mustKeep = new Set([0, records.length - 1]);
  for (let i = 0; i < records.length; i++) {
    if (records[i]?.event && String(records[i].event).trim()) {
      mustKeep.add(i);
    }
  }

  // If total rows already under maxRows AND effective rate <= targetHz + 0.35, keep all rows cleanly
  const rawHz = records.length > 1 ? ((records.length - 1) * 1000) / totalSpanMs : 0;
  if (records.length <= maxRows && rawHz <= targetHz + 0.35) {
    return [...records];
  }

  const minTargetGapMs = 1000 / Math.max(0.5, targetHz);
  const nonEventBudget = Math.max(2, maxRows - mustKeep.size);
  const capGapMs = totalSpanMs / nonEventBudget;
  const effectiveGapMs = Math.max(minTargetGapMs, capGapMs);

  const keptIndices = new Set(mustKeep);
  let lastKeptTs = records[0].ts;

  for (let i = 1; i < records.length - 1; i++) {
    if (keptIndices.has(i)) {
      lastKeptTs = records[i].ts;
      continue;
    }
    if (records[i].ts - lastKeptTs >= effectiveGapMs) {
      if (keptIndices.size < maxRows) {
        keptIndices.add(i);
        lastKeptTs = records[i].ts;
      }
    }
  }

  return Array.from(keptIndices)
    .sort((a, b) => a - b)
    .map((idx) => records[idx]);
}

export function computeBaselineComparison(currentStats, baseline) {
  if (!baseline || !Array.isArray(baseline.stats) || !Array.isArray(currentStats)) {
    return [];
  }
  const baseByPid = new Map(baseline.stats.map((s) => [s.pidHex, s]));
  const rows = [];
  for (const cur of currentStats) {
    const base = baseByPid.get(cur.pidHex);
    if (!base) continue;
    const deltaAvg = cur.avg - base.avg;
    const pctDelta = Math.abs(base.avg) > 0.001 ? (deltaAvg / Math.abs(base.avg)) * 100 : null;
    rows.push({
      pidHex: cur.pidHex,
      name: cur.name,
      unit: cur.unit,
      decimals: cur.decimals,
      currentMin: cur.min,
      currentAvg: cur.avg,
      currentMax: cur.max,
      baselineMin: base.min,
      baselineAvg: base.avg,
      baselineMax: base.max,
      deltaAvg,
      pctDelta,
    });
  }
  return rows;
}

export function buildCsvContent({
  records,
  recordedPidIds,
  pidMap,
  vehicleInfo,
  profileLabel,
  activeProfile = null,
  adapterInfo = null,
  pidHealthTracker = null,
  sessionPurpose,
  userNotes,
  isSimulatedSession,
  captureMode = false,
  samplingRateHz,
  aiSized = false,
  targetAiHz = 1.5,
  maxAiRows = 600,
}) {
  const exportRows = aiSized
    ? downsampleRecordsForAi(records, { targetHz: targetAiHz, maxRows: maxAiRows })
    : records;

  const durationS = records.length > 1
    ? ((records[records.length - 1].ts - records[0].ts) / 1000).toFixed(1)
    : '0.0';
  const durationNum = records.length > 1
    ? Math.max(0.1, (records[records.length - 1].ts - records[0].ts) / 1000)
    : 0;
  const exportedHz = durationNum > 0 && exportRows.length > 1
    ? (exportRows.length - 1) / durationNum
    : samplingRateHz || 0;

  const readinessSummary = vehicleInfo?.monitors?.length
    ? vehicleInfo.monitors.map((m) => `${m.name}:${m.ready ? 'Ready' : 'NotReady'}`).join('; ')
    : 'Not read';

  const allDtcs = [
    ...(vehicleInfo?.dtcs?.stored || []).map((c) => `${c}(stored)`),
    ...(vehicleInfo?.dtcs?.pending || []).map((c) => `${c}(pending)`),
    ...(vehicleInfo?.dtcs?.permanent || []).map((c) => `${c}(permanent)`),
  ];

  const lines = [];
  lines.push('# BayScope OBD-II Diagnostic Export');
  if (isSimulatedSession) {
    lines.push('# WARNING: SIMULATED DATA — GENERATED BY VEHICLE SIMULATOR, NOT A REAL CAR');
  }
  lines.push(`# Exported: ${new Date().toISOString()}`);
  lines.push(`# Simulated Session: ${isSimulatedSession ? 'YES (SIMULATED)' : 'NO (REAL ADAPTER)'}`);
  if (captureMode) {
    lines.push('# Capture Mode: cold-start/creep');
  }
  lines.push(`# VIN: ${vehicleInfo?.vin || 'Unavailable'}`);
  lines.push(`# Decoded Make / Year: ${[vehicleInfo?.make, vehicleInfo?.year].filter(Boolean).join(' ') || 'Unknown'}`);
  lines.push(`# Vehicle Profile: ${profileLabel}`);
  lines.push(`# Diagnostic Profile: ${activeProfile ? `${activeProfile.name} (${activeProfile.category || 'custom'})` : 'Custom layout'}`);
  lines.push(`# Adapter Identity (ATI): ${adapterInfo?.identity || (isSimulatedSession ? 'BayScope Simulator' : 'Unknown')}`);
  lines.push(`# Adapter Protocol (ATDPN): ${adapterInfo?.protocol || (isSimulatedSession ? 'Simulated CAN' : 'Unknown')}`);
  lines.push(`# Adapter TX Delay (ms): ${adapterInfo?.txDelayMs ?? 'N/A'}`);
  lines.push(`# MIL (Check Engine Light): ${vehicleInfo?.milOn ? 'ON' : 'OFF'}`);
  lines.push(`# DTC Count (0101): ${vehicleInfo?.dtcCount ?? 'Unknown'}`);
  lines.push(`# DTCs (03/07/0A): ${allDtcs.length ? allDtcs.join(', ') : 'None'}`);
  lines.push(`# Readiness Monitors: ${readinessSummary}`);
  lines.push(`# Distance Since Clear (km): ${vehicleInfo?.distanceSinceClear ?? 'Unknown'}`);
  lines.push(`# Warm-ups Since Clear: ${vehicleInfo?.warmupsSinceClear ?? 'Unknown'}`);
  lines.push(`# Distance With MIL On (km): ${vehicleInfo?.distanceWithMil ?? 'Unknown'}`);
  lines.push(`# Session Purpose: ${sessionPurpose === 'buying' ? 'Buying / Pre-purchase test drive' : 'Own vehicle diagnosis'}`);
  lines.push(`# Drive Conditions & User Notes: ${(userNotes || 'None').replace(/\r?\n/g, ' ')}`);
  lines.push(`# Raw Sample Count: ${records.length}`);
  lines.push(`# Exported Sample Count: ${exportRows.length}`);
  lines.push(`# Duration (s): ${durationS}`);
  lines.push(`# Raw Sampling Rate (Hz): ${samplingRateHz ? samplingRateHz.toFixed(2) : '0.00'}`);
  lines.push(`# Exported Effective Rate (Hz): ${exportedHz.toFixed(2)}`);
  lines.push(`# AI-Sized Export: ${aiSized ? `YES (~${targetAiHz} Hz, max ${maxAiRows} rows, all marked events preserved)` : 'NO (full resolution)'}`);
  if (pidHealthTracker?.toCsvHeaderLine) {
    lines.push(pidHealthTracker.toCsvHeaderLine(pidMap));
  }

  const unitList = recordedPidIds
    .map((id) => {
      const m = pidMap.get(id);
      return m ? `${m.shortName}(${m.unit})` : id;
    })
    .join(', ');
  lines.push(`# Recorded Variables & Units: ${unitList}`);

  // Header row
  const pidHeaders = recordedPidIds.map((id) => {
    const m = pidMap.get(id);
    return m ? `${m.shortName} (${m.unit})` : id;
  });
  lines.push(['timestamp', 'elapsed_s', 'simulated', ...pidHeaders, 'event'].map(escapeCsvCell).join(','));

  const t0 = records.length > 0 ? records[0].ts : Date.now();
  for (const row of exportRows) {
    const elapsed = ((row.ts - t0) / 1000).toFixed(2);
    const simCell = row.simulated ? 'yes' : 'no';
    const cells = recordedPidIds.map((id) => {
      const val = row.values[id];
      if (val === null || val === undefined || !Number.isFinite(val)) return '';
      const meta = pidMap.get(id);
      return meta ? val.toFixed(meta.decimals) : String(val);
    });
    lines.push([
      new Date(row.ts).toISOString(),
      elapsed,
      simCell,
      ...cells,
      row.event || '',
    ].map(escapeCsvCell).join(','));
  }

  return lines.join('\n');
}

export function buildAiPrompt({
  records,
  recordedPidIds,
  pidMap,
  vehicleInfo,
  profileLabel,
  activeProfile = null,
  adapterInfo = null,
  pidHealthTracker = null,
  baseline = null,
  sessionPurpose,
  userNotes,
  isSimulatedSession,
  samplingRateHz,
}) {
  const stats = computeSessionStats(records, recordedPidIds, pidMap);
  const eventWindows = extractMarkedMomentWindows(records, recordedPidIds, pidMap, {
    windowBeforeSec: 8,
    windowAfterSec: 8,
    maxRowsPerWindow: 40,
  });
  const durationS = records.length > 1
    ? ((records[records.length - 1].ts - records[0].ts) / 1000).toFixed(1)
    : '0.0';

  const stored = vehicleInfo?.dtcs?.stored || [];
  const pending = vehicleInfo?.dtcs?.pending || [];
  const permanent = vehicleInfo?.dtcs?.permanent || [];
  const hasAnyDtcs = stored.length > 0 || pending.length > 0 || permanent.length > 0;

  const readinessLine = vehicleInfo?.monitors?.length
    ? vehicleInfo.monitors.map((m) => `${m.name}: ${m.ready ? 'Ready' : 'Incomplete'}`).join(', ')
    : 'Not available';

  const lines = [];
  if (isSimulatedSession) {
    lines.push('*** SIMULATED SESSION WARNING: All telemetry below was generated by the BayScope simulator for testing/demonstration, NOT from a real vehicle. ***');
    lines.push('');
  }

  lines.push('You are helping analyze an OBD-II diagnostic log exported from BayScope.');
  lines.push('Be explicit about uncertainty: OBD-II telemetry points toward probable causes and cannot prove mechanical/electrical root causes on its own without physical testing.');
  lines.push('');
  lines.push('=== VEHICLE & SESSION INFO ===');
  lines.push(`Mode: ${isSimulatedSession ? 'SIMULATED' : 'Real OBD-II Adapter'}`);
  lines.push(`Purpose: ${sessionPurpose === 'buying' ? 'Pre-purchase used-car inspection / test drive' : 'Diagnosing my own vehicle'}`);
  lines.push(`VIN: ${vehicleInfo?.vin || 'Not returned by ECU'}`);
  lines.push(`Decoded Make / Year: ${[vehicleInfo?.make, vehicleInfo?.year].filter(Boolean).join(' ') || 'Unknown'}`);
  lines.push(`Vehicle Profile: ${profileLabel}`);
  lines.push(`Diagnostic Profile: ${activeProfile ? activeProfile.name : 'Custom layout'}`);
  if (adapterInfo?.identity || adapterInfo?.protocol) {
    lines.push(`Adapter: ${adapterInfo.identity || 'Unknown'} | Protocol: ${adapterInfo.protocol || 'Auto'} | TX Gap: ${adapterInfo.txDelayMs ?? '?'} ms`);
  }
  lines.push(`MIL (Check Engine Light): ${vehicleInfo?.milOn ? 'ON' : 'OFF'} (reported DTC count: ${vehicleInfo?.dtcCount ?? 'unknown'})`);
  lines.push(`Stored DTCs (Mode 03): ${stored.length ? stored.join(', ') : 'None'}`);
  lines.push(`Pending DTCs (Mode 07): ${pending.length ? pending.join(', ') : 'None'}`);
  lines.push(`Permanent DTCs (Mode 0A): ${permanent.length ? permanent.join(', ') : 'None'}`);
  lines.push(`Readiness Monitors: ${readinessLine}`);
  lines.push(`Distance / Warm-ups since codes cleared: ${vehicleInfo?.distanceSinceClear ?? 'Unknown'} km / ${vehicleInfo?.warmupsSinceClear ?? 'Unknown'} warm-ups`);
  lines.push(`Session Length: ${records.length} samples over ${durationS}s (~${samplingRateHz ? samplingRateHz.toFixed(2) : '0.00'} Hz)`);
  if (pidHealthTracker?.toSummaryString) {
    lines.push(`Telemetry Health: ${pidHealthTracker.toSummaryString(pidMap)}`);
  }
  if (userNotes && userNotes.trim()) {
    lines.push(`Driver / Buyer Notes: ${userNotes.trim()}`);
  }

  if (activeProfile && (activeProfile.analysisPrompt || (activeProfile.driveScript && activeProfile.driveScript.length))) {
    lines.push('');
    lines.push('=== DIAGNOSTIC PROFILE GUIDANCE ===');
    if (activeProfile.appliesTo) {
      lines.push(`Applies to: ${activeProfile.appliesTo}`);
    }
    if (activeProfile.symptoms) {
      lines.push(`Symptoms covered: ${activeProfile.symptoms}`);
    }
    if (activeProfile.analysisPrompt) {
      lines.push(`Analysis Prompt: ${activeProfile.analysisPrompt}`);
    }
    if (Array.isArray(activeProfile.driveScript) && activeProfile.driveScript.length > 0) {
      lines.push('Drive Script Used:');
      activeProfile.driveScript.forEach((step, idx) => {
        lines.push(`  ${idx + 1}. ${step}`);
      });
    }
    if (Array.isArray(activeProfile.whatToWatch) && activeProfile.whatToWatch.length > 0) {
      lines.push('What To Watch In The Data:');
      activeProfile.whatToWatch.forEach((item) => lines.push(`  - ${item}`));
    }
    if (Array.isArray(activeProfile.excludedGuidance) && activeProfile.excludedGuidance.length > 0) {
      lines.push('Intentionally Excluded PIDs (for sample rate):');
      activeProfile.excludedGuidance.forEach((item) => lines.push(`  - ${item}`));
    }
    if (Array.isArray(activeProfile.nextStepGuidance) && activeProfile.nextStepGuidance.length > 0) {
      lines.push('Next Step Decision Tree:');
      activeProfile.nextStepGuidance.forEach((item) => lines.push(`  - ${item}`));
    }
  }

  if (activeProfile?.isCvtProfile && !hasAnyDtcs) {
    lines.push('');
    lines.push('*** CVT ZERO-DTC CAUTION ***');
    lines.push('Zero stored/pending/permanent DTCs were reported, but this session targets CVT judder/shudder.');
    lines.push('Do NOT conclude "no action needed" based on empty DTCs. Jatco CVT shudder and TCC lockup hunting routinely occur with zero codes.');
    lines.push('Verify Nissan NS-3 fluid spec, temperature-controlled overflow fill level (35-45 C), and TCM fluid deterioration / pressure adaptation reset.');
  }

  lines.push('');
  lines.push('=== PER-VARIABLE SESSION SUMMARY ===');
  if (stats.length === 0) {
    lines.push('No live PID samples recorded yet.');
  } else {
    for (const s of stats) {
      const startEnd =
        s.first !== null && s.last !== null
          ? `start ${s.first.toFixed(s.decimals)}, end ${s.last.toFixed(s.decimals)}, `
          : '';
      lines.push(
        `- ${s.name} (${s.pidHex}, ${s.unit}): ${startEnd}min ${s.min.toFixed(s.decimals)}, avg ${s.avg.toFixed(s.decimals)}, max ${s.max.toFixed(s.decimals)} (n=${s.count})`
      );
    }
  }

  const baselineComps = computeBaselineComparison(stats, baseline);
  if (baseline) {
    lines.push('');
    lines.push('=== COMPARE TO SAVED VEHICLE BASELINE ===');
    lines.push(`Baseline Saved: ${baseline.savedAt || 'Unknown date'} (${baseline.label || 'Known-good baseline'}, ${baseline.sampleCount || '?'} samples)`);
    if (baselineComps.length === 0) {
      lines.push('No overlapping PIDs between current session and saved baseline.');
    } else {
      for (const c of baselineComps) {
        const sign = c.deltaAvg >= 0 ? '+' : '';
        const pctStr = c.pctDelta !== null ? ` (${sign}${c.pctDelta.toFixed(1)}%)` : '';
        lines.push(
          `- ${c.name} (${c.pidHex}, ${c.unit}): NOW avg ${c.currentAvg.toFixed(c.decimals)} [${c.currentMin.toFixed(c.decimals)}..${c.currentMax.toFixed(c.decimals)}] vs BASELINE avg ${c.baselineAvg.toFixed(c.decimals)} [${c.baselineMin.toFixed(c.decimals)}..${c.baselineMax.toFixed(c.decimals)}] -> delta ${sign}${c.deltaAvg.toFixed(c.decimals)} ${c.unit}${pctStr}`
        );
      }
    }
  }

  lines.push('');
  lines.push('=== MARKED MOMENTS DURING DRIVE (±8s CONTEXT WINDOWS) ===');
  if (eventWindows.length === 0) {
    lines.push('None marked.');
  } else {
    for (const w of eventWindows) {
      lines.push(`### Event: "${w.marker}" @ t+${w.atSec}s (window ${w.window}, ${w.rowCount} samples)`);
      lines.push('```csv');
      lines.push(w.csvBlock);
      lines.push('```');
    }
  }

  lines.push('');
  lines.push('=== WHAT I NEED FROM YOU ===');
  if (baseline && baselineComps.length > 0) {
    lines.push('MODE: COMPARE TO BASELINE');
    lines.push('1. Compare this drive against the saved known-good vehicle baseline above: which PIDs shifted meaningfully (mean, spread, or oscillation) and which remained unchanged?');
    lines.push('2. Rank the top 3-5 probable causes for any deviations or marked symptom moments, citing supporting and contradicting numbers.');
    lines.push('3. Recommend next diagnostic checks (cheapest/easiest first) and any follow-up drive window needed.');
    lines.push('4. State uncertainty explicitly and assess short-term drivability risk.');
  } else if (sessionPurpose === 'buying') {
    lines.push('1. Risk assessment: Summarize the red flags, yellow flags, and healthy signals in this test drive (especially fuel trims, warm-up, charging voltage, readiness monitors, and any recent code clears).');
    lines.push('2. Physical inspection list: Specific things to inspect under the hood, underneath, or on a second test drive before making an offer.');
    lines.push('3. Negotiation points: Realistic repair items or uncertainties to factor into price negotiation.');
    lines.push('4. Walk-away triggers: Clear deal-breakers where I should walk away from buying this car.');
    lines.push('5. State clearly what cannot be verified from OBD-II alone (e.g., rust, suspension, internal engine/trans wear without sensors).');
  } else {
    lines.push('1. Ranked likely causes: List the top 3–5 probable causes, citing both supporting evidence AND anything in the data that contradicts each cause.');
    lines.push('2. Next diagnostic steps (cheapest / easiest first): Visual checks, multimeter tests, smoke tests, or swap tests before buying parts.');
    lines.push('3. What to log next: Specific PIDs, driving conditions (cold start vs warm idle vs highway pull), or freeze-frame details to capture next.');
    lines.push('4. Drivability & safety: Assess whether it appears safe to keep driving short-term or if there is risk of catalytic converter/engine/transmission damage.');
    lines.push('5. Be explicit about uncertainty and avoid guessing beyond what the measurements support.');
  }

  return lines.join('\n');
}
