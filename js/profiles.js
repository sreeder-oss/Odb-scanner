// Diagnostic Profiles (shipped + custom), DTC->Profile auto-load map,
// Vehicle Profiles, My Vehicles Garage, and Per-Vehicle Known-Good Baselines.

export const SCAN_PRESETS = [
  {
    id: 'cvt_judder_jatco',
    name: 'CVT Judder — Nissan Jatco (RE0F10E/JF017E)',
    category: 'symptom',
    appliesTo: '2015 Infiniti QX60 3.5 / Nissan VQ35DE 3.5L V6 platforms (QX60, Pathfinder, Altima) with Jatco CVT (RE0F10E / JF017E)',
    symptoms: 'Low-speed shudder at 15–25 mph light throttle (0.3–0.5s sub-second CVT/TCC judder)',
    blurb: 'Trades PID count for speed (~2–3 Hz on clones vs 0.76 Hz with 8 PIDs): tracks RPM, speed, load, STFT B1, and coolant temp so 0.3–0.5s shudder windows show clearly.',
    pids: ['010C', '010D', '0104', '0106', '0105'],
    warmSwapDropPid: '0105',
    warmSwapPids: ['010C', '010D', '0104', '0106'],
    optionalPids: ['CUSTOM_JATCO_CVT', 'CUSTOM_JATCO_TCC_SLIP'],
    expectedSampleRateNote: '5 PIDs on an ELM327 clone targets ~2–3 Hz (fast enough to catch a 0.3–0.5s judder). Drop Coolant (0105) after warm-up (≥80 °C) for a 4-PID speed boost.',
    excludedGuidance: [
      'Bank 2 PIDs (0108/0109) — omitted; adds poll time with no benefit here',
      'O2 / lambda PIDs — too slow and not diagnostic for mechanical/TCC shudder',
      'LTFT (0107) — changes too slowly to matter inside a 60s test window',
      'RPM÷Speed calculated PID — kept OFF (extra overhead and ratio is too crude; inspect raw RPM vs speed traces instead)',
    ],
    isCvtProfile: true,
    driveScript: [
      'Segment 1 — COLD START (first 2 min): Cold soak (4+ hrs), idle 30s, drive gently <25 mph. Mark "cold creep" if shudder felt (points hard at CVT fluid / TCC).',
      'Segment 2 — WARM STEADY CREEP (30+ sec): At coolant 80 °C+, hold steady 15–25 mph light throttle (do NOT accelerate). Mark "warm creep shudder" if felt.',
      'Segment 3 — TCC UNLOCK TEST (30 sec): At 15–25 mph, feather throttle then lift slightly. Disappears on lift → TCC; stays → CVT belt/ratio. Mark "lift test — shudder gone" or "lift test — shudder stayed".',
      'Segment 4 — GENTLE UPHILL CREEP (30 sec): Mild incline at light throttle (loads CVT belt without downshift). Mark "uphill creep" if felt.',
    ],
    driveScriptSegments: [
      {
        title: 'Segment 1 — COLD START (first 2 minutes)',
        instruction: 'Start from a cold soak (overnight or 4+ hours). Let it idle 30s, then drive gently below 25 mph.',
        why: 'Why: judder only when cold points hard at CVT fluid / TCC.',
        marks: ['cold creep'],
      },
      {
        title: 'Segment 2 — WARM STEADY CREEP (30+ seconds)',
        instruction: 'Once coolant is 80 °C+, hold 15–25 mph at light throttle. Do NOT accelerate — steady creep only.',
        why: 'Why: this is the classic Jatco CVT judder window.',
        marks: ['warm creep shudder'],
      },
      {
        title: 'Segment 3 — TCC UNLOCK TEST (30 seconds)',
        instruction: 'At the same 15–25 mph, feather throttle then lift slightly. Disappears on lift → TCC; stays → CVT belt/ratio.',
        why: 'Why: separates torque converter clutch lockup shudder from belt/pulley ratio judder.',
        marks: ['lift test — shudder gone', 'lift test — shudder stayed'],
      },
      {
        title: 'Segment 4 — GENTLE UPHILL CREEP (30 seconds)',
        instruction: 'Find a mild incline and creep up at light throttle without triggering a downshift.',
        why: 'Why: loads the CVT belt gently under steady torque.',
        marks: ['uphill creep'],
      },
    ],
    whatToWatch: [
      'RPM flutter at steady speed → TCC shudder',
      'RPM climbing without speed climbing → belt slip',
      'STFT swinging ±10–14% at steady light load → TCC fueling oscillation',
      'Shudder only when coolant < 60 °C → CVT fluid temp / cold viscosity issue',
      'Shudder only when coolant > 80 °C → belt / ratio issue',
    ],
    nextStepGuidance: [
      'RPM flutter at steady speed → TCC (torque converter clutch)',
      'RPM climb without speed climb → CVT belt / pulley slip',
      'Neither shown in log despite felt shudder → mounts or TCM-side issue generic OBD-II cannot see (Dealer Consult scan next)',
    ],
    analysisPrompt:
      'OBD-II log from 2015 Infiniti QX60 / Nissan VQ35DE 3.5L V6 + Jatco CVT (RE0F10E/JF017E, ~250k mi). Symptom: low-speed 15–25 mph light-throttle shudder (0.3–0.5s duration). Logged 5 fast PIDs (010C RPM, 010D Speed, 0104 Load, 0106 STFT B1, 0105 Coolant — Bank 2, LTFT, O2, and RPM÷Speed intentionally excluded for max sample rate). Analyze: (1) RPM flutter at steady 15–25 mph speed → TCC shudder vs RPM climbing without speed climbing → belt slip, (2) STFT B1 oscillation amplitude at steady light load (±10–14% swings suggest TCC fueling oscillation), (3) Coolant temp (<60 °C cold fluid/TCC vs >80 °C belt/ratio) correlation, (4) Compare numbers against marked moments ("cold creep", "warm creep shudder", "lift test — shudder gone/stayed", "uphill creep") as ground truth. Triage next step (TCC vs CVT belt vs mounts/TCM needing Dealer Consult scan). State uncertainty explicitly and do NOT dismiss as "no action needed" merely because no DTCs are stored.',
  },
  {
    id: 'pre_purchase',
    name: 'Pre-purchase test drive',
    category: 'maintenance',
    blurb: 'Checks warm-up, fuel trims, battery charging, and recent code clears before you buy.',
    pids: ['010C', '010D', '0105', '0106', '0107', '0142'],
    driveScript: [
      'Inspect cold start — compare Coolant vs Intake Air Temp before cranking.',
      'Warm idle for 2 minutes — watch STFT/LTFT and battery charging voltage (13.6–14.6 V).',
      'City cruise 25–40 mph — verify smooth acceleration and coolant reaching 85–95 °C.',
      'Check Trouble Codes & Readiness view for incomplete monitors or recent clears (<80 km).',
    ],
    analysisPrompt:
      'Pre-purchase test-drive OBD-II log. Evaluate warm-up behavior, fuel trim balance (B1 vs B2), charging voltage, readiness monitors, and any evidence of recently cleared fault codes. Highlight red flags, walk-away triggers, and physical checks needed.',
  },
  {
    id: 'general',
    name: 'General health',
    category: 'maintenance',
    blurb: 'Balanced everyday check of RPM, speed, coolant, engine load, STFT B1, and battery voltage.',
    pids: ['010C', '010D', '0105', '0104', '0106', '0142'],
    driveScript: [
      'Idle 60 seconds after warm-up to establish baseline RPM, load, and trims.',
      'Steady 35–45 mph cruise for 60 seconds.',
      'Moderate merge acceleration to check load response and fueling.',
    ],
    analysisPrompt:
      'General OBD-II health check log. Summarize baseline idle stability, fuel trims, operating temperatures, engine load, and charging voltage. Note any subtle anomalies or follow-up checks.',
  },
  {
    id: 'cold_start',
    name: 'Cold start & warm-up',
    category: 'maintenance',
    blurb: 'Tracks cold-soak temp match (Coolant vs IAT/Ambient), warm-up rate, idle stability, STFT B1, and charging voltage.',
    pids: ['0105', '010F', '010C', '0106', '0142', '010D'],
    driveScript: [
      'Before starting (KOEO): compare Coolant vs IAT/Ambient — after a true cold soak they should be close.',
      'Start engine and watch initial RPM flare, settle speed, and charging voltage.',
      'Drive gently as coolant rises from cold through ~80–90 °C and mark any hesitation or noise.',
    ],
    analysisPrompt:
      'Cold-start and warm-up OBD-II log. Summarize starting coolant vs IAT/ambient temperature, warm-up rate, idle stability, fuel trim behavior, and charging voltage. Note any anomalies and state uncertainty.',
  },
  {
    id: 'fuel',
    name: 'Fuel-trim hunt',
    category: 'code',
    blurb: 'Pinpoints vacuum leaks, MAF errors, and rich/lean conditions with STFT/LTFT, MAF, MAP, and Total FT B1 (P0171/P0174/P0172/P0175).',
    pids: ['010C', '0106', '0107', '0110', '010B', 'CALC_TOTAL_FT_B1'],
    driveScript: [
      'Warm idle in Park/Neutral for 60 seconds (vacuum leaks show highest +STFT/+LTFT here).',
      'Hold steady 2,000–2,500 RPM parked or steady highway cruise for 30 seconds (if trims drop toward 0%, points to vacuum leak; if trims stay high or worsen, points to MAF/fuel delivery).',
      'Decelerate off-throttle from 45 mph to observe O2 response.',
    ],
    analysisPrompt:
      'Fuel-trim diagnostic log (lean/rich investigation). Compare total fuel trims (STFT+LTFT) at idle vs 2,500 RPM cruise, Bank 1 vs Bank 2 symmetry, MAF g/s plausibility, and O2 switching. Rank vacuum leak vs MAF vs fuel delivery vs exhaust leak with uncertainty.',
  },
  {
    id: 'misfire',
    name: 'Misfire / rough idle',
    category: 'code',
    blurb: 'Tracks idle stability, load, timing advance, STFT B1, MAF, and coolant during shakes (P0300–P0308).',
    pids: ['010C', '0104', '010E', '0106', '0110', '0105'],
    driveScript: [
      'Cold start idle for 90 seconds — mark moment if rough idle occurs.',
      'Hold in Drive with brake applied at stoplight for 30 seconds (loaded idle).',
      'Light-throttle acceleration up a gentle grade (high-load ignition misfire check).',
    ],
    analysisPrompt:
      'Misfire / rough idle OBD-II log. Analyze RPM stability, ignition timing advance jitter, calculated load, MAF/MAP correlation, and fuel trim spikes during marked rough moments. Recommend cheapest next checks (plugs, coil swap, fuel/compression) and note uncertainty.',
  },
  {
    id: 'warmup',
    name: 'Warm-up / thermostat',
    category: 'code',
    blurb: 'Watches coolant rise vs. intake air, ambient temp, run time, STFT B1, and voltage to catch stuck-open thermostats (P0128).',
    pids: ['0105', '010F', '0146', '011F', '0106', '0142'],
    driveScript: [
      'Start cold — verify Coolant matches Ambient/IAT within ~3 °C.',
      'Drive continuously for 10+ minutes until coolant plateaus.',
      'Cruise at 50–60 mph for 2 minutes — watch if coolant drops below 80 °C (stuck-open thermostat).',
    ],
    analysisPrompt:
      'Warm-up & cooling diagnostic log. Analyze coolant temperature rise rate vs Run Time, steady-state operating temperature during highway airflow, and closed-loop fuel trim transition.',
  },
  {
    id: 'transmission',
    name: 'Transmission / drivetrain',
    category: 'code',
    blurb: 'Watches RPM-to-speed ratio, engine load, throttle demand, and coolant for torque converter/CVT behavior (P0700–P0799 / P17xx).',
    pids: ['010C', '010D', 'CALC_RPM_SPEED', '0104', '0111', '0105'],
    driveScript: [
      'Gentle acceleration through each speed range (0–50 mph) and mark any flare or harsh shift.',
      'Steady cruise at 25 mph and 45 mph to inspect RPM/Speed ratio lockup stability.',
      'Uphill light-throttle hold to test converter clutch / belt hold.',
    ],
    analysisPrompt:
      'Transmission / drivetrain OBD-II log. Analyze RPM/Speed ratio stability under steady cruise vs light throttle, throttle/pedal demand correlation, engine load response, and any flare or shudder events marked.',
  },
  {
    id: 'catalyst',
    name: 'Catalyst / emissions',
    category: 'code',
    blurb: 'Compares upstream vs. downstream O2 sensors, wideband lambda, catalyst temp, and STFT B1 (P0420/P0430).',
    pids: ['0114', '0115', '0124', '0125', '013C', '0106'],
    driveScript: [
      'Warm engine fully until catalyst reaches >400 °C.',
      'Hold steady 45–55 mph cruise for 2 minutes so downstream O2 (B1S2) settles.',
    ],
    analysisPrompt:
      'Catalyst & emissions diagnostic log. Compare upstream vs downstream O2 activity, wideband lambda, catalyst temperatures, and fuel trims to evaluate catalyst efficiency vs exhaust/O2 sensor faults.',
  },
  {
    id: 'economy',
    name: 'Fuel economy',
    category: 'maintenance',
    blurb: 'Estimates instant MPG from MAF and speed alongside RPM, engine load, and coolant temperature.',
    pids: ['010D', '010C', '0110', 'CALC_INST_MPG', '0104', '0105'],
    driveScript: [
      'Steady flat-ground cruise at 45 mph and 65 mph for 60 seconds each.',
      'Normal city stop-and-go segment to capture idle fuel rate.',
    ],
    analysisPrompt:
      'Fuel economy diagnostic log. Review estimated MPG, MAF airflow, engine load, coolant temperature (thermostat fully warm?), and fuel trims to spot efficiency losses.',
  },
  {
    id: 'hybrid',
    name: 'Hybrid system',
    category: 'maintenance',
    blurb: 'Monitors HV battery pack SOC, engine start/stop RPM, speed, 12V charging voltage, coolant, and load.',
    pids: ['015B', '010C', '010D', '0142', '0105', '0104'],
    driveScript: [
      'Start Ready mode and observe HV Pack SOC and 12V charging voltage (13.8–14.5 V).',
      'Low-speed EV creep followed by gentle acceleration to trigger ICE handoff.',
    ],
    analysisPrompt:
      'Hybrid system diagnostic log. Inspect HV battery SOC behavior, ICE engagement transitions, coolant warm-up, and 12V auxiliary charging stability.',
  },
];

// DTC -> Profile auto-load mapping
export const DTC_PROFILE = {
  P0171: 'fuel',
  P0172: 'fuel',
  P0174: 'fuel',
  P0175: 'fuel',
  P0101: 'fuel',
  P0102: 'fuel',

  P0300: 'misfire',
  P0301: 'misfire',
  P0302: 'misfire',
  P0303: 'misfire',
  P0304: 'misfire',
  P0305: 'misfire',
  P0306: 'misfire',
  P0307: 'misfire',
  P0308: 'misfire',

  P0420: 'catalyst',
  P0430: 'catalyst',
  P0440: 'catalyst',
  P0441: 'catalyst',
  P0442: 'catalyst',
  P0455: 'catalyst',
  P0456: 'catalyst',
  P0401: 'catalyst',

  P0128: 'warmup',
  P0117: 'warmup',
  P0118: 'warmup',
  P0113: 'warmup',

  P0700: 'transmission',
  P0705: 'transmission',
  P0710: 'transmission',
  P0715: 'transmission',
  P0720: 'transmission',
  P0730: 'transmission',
  P0740: 'transmission',
  P0741: 'transmission',
  P0744: 'cvt_judder_jatco',
  P0746: 'cvt_judder_jatco',
  P0840: 'cvt_judder_jatco',
  P0845: 'cvt_judder_jatco',
  P0868: 'cvt_judder_jatco',
  P0965: 'cvt_judder_jatco',
  P1700: 'cvt_judder_jatco',
  P1705: 'cvt_judder_jatco',
  P1715: 'cvt_judder_jatco',
  P1722: 'cvt_judder_jatco',
  P1777: 'cvt_judder_jatco',
  P1778: 'cvt_judder_jatco',
};

export const DTC_DESCRIPTIONS = {
  P0101: 'Mass Air Flow (MAF) Circuit Range/Performance',
  P0102: 'Mass Air Flow (MAF) Circuit Low Input',
  P0113: 'Intake Air Temperature (IAT) Sensor High Input',
  P0117: 'Engine Coolant Temperature Circuit Low Input',
  P0118: 'Engine Coolant Temperature Circuit High Input',
  P0128: 'Coolant Thermostat (Coolant Temp Below Regulating Temp)',
  P0171: 'System Too Lean (Bank 1)',
  P0172: 'System Too Rich (Bank 1)',
  P0174: 'System Too Lean (Bank 2)',
  P0175: 'System Too Rich (Bank 2)',
  P0300: 'Random / Multiple Cylinder Misfire Detected',
  P0301: 'Cylinder 1 Misfire Detected',
  P0302: 'Cylinder 2 Misfire Detected',
  P0303: 'Cylinder 3 Misfire Detected',
  P0304: 'Cylinder 4 Misfire Detected',
  P0305: 'Cylinder 5 Misfire Detected',
  P0306: 'Cylinder 6 Misfire Detected',
  P0307: 'Cylinder 7 Misfire Detected',
  P0308: 'Cylinder 8 Misfire Detected',
  P0401: 'Exhaust Gas Recirculation (EGR) Flow Insufficient',
  P0420: 'Catalyst System Efficiency Below Threshold (Bank 1)',
  P0430: 'Catalyst System Efficiency Below Threshold (Bank 2)',
  P0440: 'Evaporative Emission (EVAP) System Malfunction',
  P0441: 'EVAP System Incorrect Purge Flow',
  P0442: 'EVAP System Small Leak Detected',
  P0455: 'EVAP System Large Leak Detected',
  P0456: 'EVAP System Very Small Leak Detected',
  P0700: 'Transmission Control System Malfunction',
  P0705: 'Transmission Range Sensor Circuit Malfunction',
  P0710: 'Transmission Fluid Temperature Sensor Circuit',
  P0715: 'Input / Turbine Speed Sensor Circuit',
  P0720: 'Output Speed Sensor Circuit',
  P0730: 'Incorrect Gear Ratio (Slip / Mechanical)',
  P0740: 'Torque Converter Clutch Circuit Malfunction',
  P0741: 'Torque Converter Clutch Performance / Stuck Off',
  P0744: 'Torque Converter Clutch Circuit Intermittent',
  P0746: 'Pressure Control Solenoid A Performance / Stuck Off',
  P0840: 'Transmission Fluid Pressure Sensor/Switch A Circuit',
  P0845: 'Transmission Fluid Pressure Sensor/Switch B Circuit',
  P0868: 'Transmission Fluid Pressure Low (Jatco CVT Secondary Pressure)',
  P0965: 'Pressure Control Solenoid B Control Circuit Range/Performance',
  P1700: 'CVT Control System / Speed Sensor Malfunction (Nissan)',
  P1705: 'Throttle Position Sensor Circuit (Transmission / CVT)',
  P1715: 'Input Speed Sensor / Primary Pulley Speed Circuit (Nissan CVT)',
  P1722: 'Estimated Vehicle Speed Signal Error (Nissan CVT)',
  P1777: 'Step Motor Circuit (Nissan Jatco CVT)',
  P1778: 'Step Motor Function (Nissan Jatco CVT)',
};

export const CVT_SERVICE_CHECKLIST = {
  title: 'Jatco CVT Fluid Service Reminder & Checklist',
  caution:
    'Zero stored DTCs does NOT mean "no action needed" when low-speed judder (15–25 mph light throttle) is present — Jatco belt/TCC shudder commonly happens well before setting a code.',
  items: [
    'Fluid specification: Genuine Nissan NS-3 CVT fluid only (never generic multi-vehicle "universal CVT" fluid or conventional ATF).',
    'Temperature-controlled fill level: Final overflow-plug check must be performed engine running within the factory CVT fluid temperature window (typically 35–45 °C / 95–113 °F).',
    'TCM adaptation & deterioration reset: Reset CVT fluid deterioration counter and line-pressure adaptations after service (Consult-III+ or compatible bi-directional scan tool).',
  ],
  nonDealerMistakes: [
    'Using universal / non-NS-3 fluid with mismatched friction modifiers or viscosity.',
    'Setting fluid level cold or guessing drain-measure-refill volume without overflow temp verification (causing foaming or starvation).',
    'Skipping the TCM CVT fluid deterioration / pressure adaptation reset after fluid replacement.',
  ],
};

export function findMatchingPresetsForDtcs(dtcCodes, vehicleProfile = null) {
  const isCvtOrNissan = Boolean(
    vehicleProfile &&
      (vehicleProfile.mfrId === 'nissan' || /CVT|Jatco/i.test(vehicleProfile.transId || ''))
  );
  const matched = new Set();

  for (const code of dtcCodes || []) {
    const upper = String(code).trim().toUpperCase();
    if (!upper) continue;

    if (/^P030[0-8]$/.test(upper)) {
      matched.add('misfire');
      continue;
    }
    if (/^P17[0-9A-F]{2}$/.test(upper)) {
      matched.add('cvt_judder_jatco');
      continue;
    }
    if (/^P0(7|8|9)[0-9A-F]{2}$/.test(upper)) {
      if (isCvtOrNissan || DTC_PROFILE[upper] === 'cvt_judder_jatco') {
        matched.add('cvt_judder_jatco');
      } else {
        matched.add('transmission');
      }
      continue;
    }
    if (DTC_PROFILE[upper]) {
      const target = DTC_PROFILE[upper];
      if (target === 'transmission' && isCvtOrNissan) {
        matched.add('cvt_judder_jatco');
      } else {
        matched.add(target);
      }
    }
  }
  return Array.from(matched);
}

export function findMatchingPresetForDtcs(dtcCodes, vehicleProfile = null) {
  const list = findMatchingPresetsForDtcs(dtcCodes, vehicleProfile);
  return list.length > 0 ? list[0] : null;
}

// Custom User Profiles Storage
const CUSTOM_PROFILES_KEY = 'bayscope_custom_profiles_v1';

export function loadCustomProfiles() {
  try {
    const raw = localStorage.getItem(CUSTOM_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((p) => ({
      ...p,
      isCustom: true,
      category: p.category || 'symptom',
      pids: Array.isArray(p.pids) ? p.pids : [],
      driveScript: Array.isArray(p.driveScript) ? p.driveScript : [],
      analysisPrompt: p.analysisPrompt || '',
    }));
  } catch {
    return [];
  }
}

export function saveCustomProfiles(list) {
  const clean = (list || []).map((p) => ({
    id: p.id,
    name: String(p.name || 'Custom Profile').trim(),
    category: p.category || 'symptom',
    blurb: String(p.blurb || '').trim(),
    pids: Array.isArray(p.pids) ? p.pids : [],
    driveScript: Array.isArray(p.driveScript) ? p.driveScript.filter(Boolean) : [],
    analysisPrompt: String(p.analysisPrompt || '').trim(),
    isCvtProfile: Boolean(p.isCvtProfile),
    isCustom: true,
  }));
  localStorage.setItem(CUSTOM_PROFILES_KEY, JSON.stringify(clean));
  return clean;
}

export function getAllProfiles(customProfiles = []) {
  return [...SCAN_PRESETS, ...(customProfiles || [])];
}

// Vehicle Profile Catalog (Manufacturer -> Engine -> Transmission)
export const VEHICLE_CATALOG = [
  {
    id: 'toyota',
    name: 'Toyota / Lexus',
    engines: [
      { id: '1GR-FE', name: '1GR-FE 4.0L V6 (4Runner / Tacoma / FJ)', banks: 2, hybrid: false, transmissions: ['5AT (A750)', '6AT (AC60)', 'Manual'] },
      { id: '2GR-FE-FKS', name: '2GR-FE / 2GR-FKS 3.5L V6 (Highlander / Camry / Tacoma)', banks: 2, hybrid: false, transmissions: ['6AT (U660)', '8AT (UA80)', 'Manual'] },
      { id: '2AR-FE', name: '2AR-FE 2.5L I4 (RAV4 / Camry)', banks: 1, hybrid: false, transmissions: ['6AT (U760)'] },
      { id: 'A25A-FKS', name: 'A25A-FKS 2.5L I4 (Dynamic Force)', banks: 1, hybrid: false, transmissions: ['8AT (UB80)', 'CVT'] },
      { id: 'A25A-FXS', name: 'A25A-FXS 2.5L Hybrid I4', banks: 1, hybrid: true, transmissions: ['eCVT (Hybrid)'] },
      { id: '2ZR-FE', name: '2ZR-FE 1.8L I4 (Corolla / Matrix)', banks: 1, hybrid: false, transmissions: ['CVT (K313)', '4AT', 'Manual'] },
    ],
  },
  {
    id: 'nissan',
    name: 'Nissan / Infiniti',
    engines: [
      { id: 'VQ35DE', name: 'VQ35DE 3.5L V6 (QX60 / Pathfinder / Altima)', banks: 2, hybrid: false, transmissions: ['Jatco CVT (RE0F10E/JF017E)', '5AT / 6AT'] },
      { id: 'VQ37VHR', name: 'VQ37VHR 3.7L V6 (QX70 / Q50 / G37)', banks: 2, hybrid: false, transmissions: ['7AT (RE7R01A)', '6MT Manual'] },
      { id: 'QR25DE', name: 'QR25DE 2.5L I4 (Rogue / Altima / Sentra)', banks: 1, hybrid: false, transmissions: ['Jatco CVT', 'Manual'] },
      { id: 'MR20DE', name: 'MR20DE 2.0L I4 (Rogue Sport / Sentra)', banks: 1, hybrid: false, transmissions: ['Jatco CVT', 'Manual'] },
      { id: 'HR16DE', name: 'HR16DE 1.6L I4 (Versa / Kicks)', banks: 1, hybrid: false, transmissions: ['Jatco CVT', '5MT Manual'] },
    ],
  },
  {
    id: 'generic',
    name: 'Generic / Other Make',
    engines: [
      { id: 'GEN-I4', name: 'Generic 4-Cylinder (Single Bank)', banks: 1, hybrid: false, transmissions: ['Automatic', 'CVT', 'Manual'] },
      { id: 'GEN-V6-V8', name: 'Generic V6 / V8 (Dual Bank)', banks: 2, hybrid: false, transmissions: ['Automatic', 'Manual'] },
      { id: 'GEN-HYBRID', name: 'Generic Hybrid / PHEV', banks: 1, hybrid: true, transmissions: ['eCVT / Hybrid'] },
    ],
  },
];

const LAYOUTS_KEY = 'bayscope_combo_layouts_v1';
const GARAGE_KEY = 'bayscope_garage_v1';
const BASELINES_KEY = 'bayscope_vehicle_baselines_v1';

export function getComboKey(mfrId, engineId, transId) {
  return `${mfrId}|${engineId}|${transId}`;
}

export function getBaselineKey(vin, mfrId, engineId, transId) {
  if (vin && String(vin).trim().length >= 8) {
    return `VIN:${String(vin).trim().toUpperCase()}`;
  }
  return `COMBO:${getComboKey(mfrId, engineId, transId)}`;
}

export function loadBaselines() {
  try {
    const raw = localStorage.getItem(BASELINES_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getBaselineForVehicle(vin, mfrId, engineId, transId) {
  const all = loadBaselines();
  if (vin && all[`VIN:${String(vin).trim().toUpperCase()}`]) {
    return all[`VIN:${String(vin).trim().toUpperCase()}`];
  }
  return all[`COMBO:${getComboKey(mfrId, engineId, transId)}`] || null;
}

export function saveBaselineForVehicle(key, baselineObj) {
  const all = loadBaselines();
  all[key] = baselineObj;
  localStorage.setItem(BASELINES_KEY, JSON.stringify(all));
  return all[key];
}

export function clearBaselineForVehicle(key) {
  const all = loadBaselines();
  delete all[key];
  localStorage.setItem(BASELINES_KEY, JSON.stringify(all));
}

export function getEngineMeta(mfrId, engineId) {
  const mfr = VEHICLE_CATALOG.find((m) => m.id === mfrId) || VEHICLE_CATALOG[2];
  const eng = mfr.engines.find((e) => e.id === engineId) || mfr.engines[0];
  return { mfr, eng };
}

export function loadComboLayout(comboKey) {
  try {
    const raw = localStorage.getItem(LAYOUTS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw);
    return all[comboKey] || null;
  } catch {
    return null;
  }
}

export function saveComboLayout(comboKey, pidList, chartPids) {
  try {
    const raw = localStorage.getItem(LAYOUTS_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[comboKey] = { pids: pidList, chartPids };
    localStorage.setItem(LAYOUTS_KEY, JSON.stringify(all));
  } catch {
    // Ignore storage quota errors
  }
}

export function loadGarage() {
  try {
    const raw = localStorage.getItem(GARAGE_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export function saveGarage(list) {
  localStorage.setItem(GARAGE_KEY, JSON.stringify(list));
}
