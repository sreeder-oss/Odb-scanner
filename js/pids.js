import { compileFormula } from './formula.js';

const b2 = (bytes) => (bytes && bytes.length >= 2 ? bytes[0] * 256 + bytes[1] : null);
const b1 = (bytes) => (bytes && bytes.length >= 1 ? bytes[0] : null);
const trimPct = (bytes) => {
  const a = b1(bytes);
  return a === null ? null : ((a - 128) * 100) / 128;
};
const o2Volts = (bytes) => {
  const a = b1(bytes);
  return a === null ? null : a / 200;
};
const widebandLambda = (bytes) => {
  const ab = b2(bytes);
  return ab === null ? null : (2 / 65536) * ab;
};
const catTemp = (bytes) => {
  const ab = b2(bytes);
  return ab === null ? null : ab / 10 - 40;
};

// ~53 Standard SAE J1979 Mode 01 PIDs
export const STANDARD_PIDS = [
  {
    pidHex: '010C',
    name: 'Engine RPM',
    shortName: 'RPM',
    unit: 'rpm',
    min: 0,
    max: 7500,
    decimals: 0,
    category: 'engine',
    bank: null,
    priority: 1,
    tooltip: 'Engine crankshaft speed in revolutions per minute. Normal warm idle is typically 600–850 rpm.',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab / 4;
    },
  },
  {
    pidHex: '010D',
    name: 'Vehicle Speed',
    shortName: 'Speed',
    unit: 'km/h',
    min: 0,
    max: 220,
    decimals: 0,
    category: 'vehicle',
    bank: null,
    priority: 2,
    tooltip: 'Road speed reported by the vehicle speed sensor or ABS module.',
    decodeBytes: (bytes) => b1(bytes),
  },
  {
    pidHex: '0105',
    name: 'Engine Coolant Temp',
    shortName: 'Coolant',
    unit: '°C',
    min: -40,
    max: 130,
    decimals: 0,
    category: 'temps',
    bank: null,
    priority: 3,
    tooltip: 'Normal warmed-up coolant temperature is 85–102 °C. Stuck below ~78 °C after 10 min driving points to an open thermostat.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 40;
    },
  },
  {
    pidHex: '0104',
    name: 'Calculated Engine Load',
    shortName: 'Load',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'engine',
    bank: null,
    priority: 4,
    tooltip: 'Percentage of peak available engine torque being used. Warm idle is typically 15–28%.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0106',
    name: 'Short Term Fuel Trim B1',
    shortName: 'STFT B1',
    unit: '%',
    min: -25,
    max: 25,
    decimals: 1,
    category: 'fuel',
    bank: 1,
    priority: 5,
    tooltip: 'Immediate fuel correction on Bank 1. Healthy values stay near -8% to +8%. Positive adds fuel (lean condition).',
    decodeBytes: trimPct,
  },
  {
    pidHex: '0107',
    name: 'Long Term Fuel Trim B1',
    shortName: 'LTFT B1',
    unit: '%',
    min: -25,
    max: 25,
    decimals: 1,
    category: 'fuel',
    bank: 1,
    priority: 6,
    tooltip: 'Learned fuel adaptation on Bank 1. Sustained values beyond ±10% indicate vacuum leaks, MAF error, or fuel delivery issues.',
    decodeBytes: trimPct,
  },
  {
    pidHex: '0142',
    name: 'Control Module Voltage',
    shortName: 'Battery V',
    unit: 'V',
    min: 10,
    max: 16,
    decimals: 2,
    category: 'vehicle',
    bank: null,
    priority: 7,
    tooltip: 'System voltage seen by the ECU. Key-on engine-off ~12.4–12.7 V; engine running ~13.6–14.6 V.',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab / 1000;
    },
  },
  {
    pidHex: '0111',
    name: 'Throttle Position',
    shortName: 'Throttle',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 8,
    tooltip: 'Relative throttle plate opening. Note many drive-by-wire cars read 10–18% at idle.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0110',
    name: 'Mass Air Flow (MAF)',
    shortName: 'MAF',
    unit: 'g/s',
    min: 0,
    max: 250,
    decimals: 2,
    category: 'air',
    bank: null,
    priority: 9,
    tooltip: 'Grams of air entering the engine per second. Rough rule of thumb: warm idle g/s ≈ engine displacement in liters (e.g. 3.5L ≈ 3.2–4.2 g/s).',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab / 100;
    },
  },
  {
    pidHex: '010B',
    name: 'Intake Manifold Pressure (MAP)',
    shortName: 'MAP',
    unit: 'kPa',
    min: 10,
    max: 255,
    decimals: 0,
    category: 'air',
    bank: null,
    priority: 10,
    tooltip: 'Absolute intake manifold pressure. At warm idle expect 28–40 kPa (strong vacuum); ~100 kPa at full throttle (naturally aspirated).',
    decodeBytes: (bytes) => b1(bytes),
  },
  {
    pidHex: '0108',
    name: 'Short Term Fuel Trim B2',
    shortName: 'STFT B2',
    unit: '%',
    min: -25,
    max: 25,
    decimals: 1,
    category: 'fuel',
    bank: 2,
    priority: 11,
    tooltip: 'Immediate fuel correction on Bank 2 (V6/V8 engines). Compare directly against Bank 1.',
    decodeBytes: trimPct,
  },
  {
    pidHex: '0109',
    name: 'Long Term Fuel Trim B2',
    shortName: 'LTFT B2',
    unit: '%',
    min: -25,
    max: 25,
    decimals: 1,
    category: 'fuel',
    bank: 2,
    priority: 12,
    tooltip: 'Learned fuel adaptation on Bank 2. If only one bank is high, suspect an exhaust leak, injector, or O2 sensor on that bank.',
    decodeBytes: trimPct,
  },
  {
    pidHex: '010F',
    name: 'Intake Air Temp',
    shortName: 'IAT',
    unit: '°C',
    min: -40,
    max: 100,
    decimals: 0,
    category: 'temps',
    bank: null,
    priority: 13,
    tooltip: 'Temperature of air entering the intake. After an overnight cold soak, IAT and Coolant should match ambient within ~2–3 °C.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 40;
    },
  },
  {
    pidHex: '010E',
    name: 'Timing Advance (Cyl 1)',
    shortName: 'Timing',
    unit: '°',
    min: -20,
    max: 60,
    decimals: 1,
    category: 'engine',
    bank: null,
    priority: 14,
    tooltip: 'Ignition timing advance before TDC. Warm idle typically 8–18°; drops suddenly under knock retard.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a / 2 - 64;
    },
  },
  {
    pidHex: '0133',
    name: 'Barometric Pressure',
    shortName: 'Baro',
    unit: 'kPa',
    min: 50,
    max: 115,
    decimals: 0,
    category: 'air',
    bank: null,
    priority: 15,
    tooltip: 'Ambient atmospheric pressure (~101 kPa at sea level, ~84 kPa at 1,600 m / 5,280 ft).',
    decodeBytes: (bytes) => b1(bytes),
  },
  {
    pidHex: '0146',
    name: 'Ambient Air Temp',
    shortName: 'Ambient',
    unit: '°C',
    min: -40,
    max: 70,
    decimals: 0,
    category: 'temps',
    bank: null,
    priority: 16,
    tooltip: 'Outside air temperature measured by the vehicle ambient sensor.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 40;
    },
  },
  {
    pidHex: '0114',
    name: 'O2 Sensor B1S1 Voltage',
    shortName: 'O2 B1S1',
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 3,
    category: 'o2',
    bank: 1,
    priority: 17,
    tooltip: 'Upstream narrowband oxygen sensor Bank 1. Healthy sensor switches briskly between ~0.1 V and ~0.85 V in closed loop.',
    decodeBytes: o2Volts,
  },
  {
    pidHex: '0115',
    name: 'O2 Sensor B1S2 Voltage',
    shortName: 'O2 B1S2',
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 3,
    category: 'o2',
    bank: 1,
    priority: 18,
    tooltip: 'Downstream oxygen sensor after catalyst (Bank 1). A healthy cat holds B1S2 steady (~0.6–0.8 V); rapid mirroring of B1S1 suggests P0420.',
    decodeBytes: o2Volts,
  },
  {
    pidHex: '0116',
    name: 'O2 Sensor B1S3 Voltage',
    shortName: 'O2 B1S3',
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 3,
    category: 'o2',
    bank: 1,
    priority: 40,
    tooltip: 'Third oxygen sensor on Bank 1 (if equipped).',
    decodeBytes: o2Volts,
  },
  {
    pidHex: '0118',
    name: 'O2 Sensor B2S1 Voltage',
    shortName: 'O2 B2S1',
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 3,
    category: 'o2',
    bank: 2,
    priority: 25,
    tooltip: 'Upstream narrowband oxygen sensor Bank 2.',
    decodeBytes: o2Volts,
  },
  {
    pidHex: '0119',
    name: 'O2 Sensor B2S2 Voltage',
    shortName: 'O2 B2S2',
    unit: 'V',
    min: 0,
    max: 1.275,
    decimals: 3,
    category: 'o2',
    bank: 2,
    priority: 26,
    tooltip: 'Downstream catalyst monitor oxygen sensor Bank 2.',
    decodeBytes: o2Volts,
  },
  {
    pidHex: '0124',
    name: 'Wideband O2 B1S1 (λ)',
    shortName: 'WB λ B1S1',
    unit: 'λ',
    min: 0.5,
    max: 1.5,
    decimals: 3,
    category: 'o2',
    bank: 1,
    priority: 19,
    tooltip: 'Air-fuel equivalence ratio (lambda) for wideband A/F sensor Bank 1. 1.000 = stoichiometric (14.7:1 gasoline); <1 rich, >1 lean.',
    decodeBytes: widebandLambda,
  },
  {
    pidHex: '0125',
    name: 'Wideband O2 B1S2 (λ)',
    shortName: 'WB λ B1S2',
    unit: 'λ',
    min: 0.5,
    max: 1.5,
    decimals: 3,
    category: 'o2',
    bank: 1,
    priority: 20,
    tooltip: 'Wideband equivalence ratio for downstream Bank 1 sensor.',
    decodeBytes: widebandLambda,
  },
  {
    pidHex: '0128',
    name: 'Wideband O2 B2S1 (λ)',
    shortName: 'WB λ B2S1',
    unit: 'λ',
    min: 0.5,
    max: 1.5,
    decimals: 3,
    category: 'o2',
    bank: 2,
    priority: 27,
    tooltip: 'Wideband A/F equivalence ratio on Bank 2 upstream sensor.',
    decodeBytes: widebandLambda,
  },
  {
    pidHex: '0129',
    name: 'Wideband O2 B2S2 (λ)',
    shortName: 'WB λ B2S2',
    unit: 'λ',
    min: 0.5,
    max: 1.5,
    decimals: 3,
    category: 'o2',
    bank: 2,
    priority: 28,
    tooltip: 'Wideband equivalence ratio on Bank 2 downstream sensor.',
    decodeBytes: widebandLambda,
  },
  {
    pidHex: '013C',
    name: 'Catalyst Temp B1S1',
    shortName: 'Cat B1S1',
    unit: '°C',
    min: 0,
    max: 1000,
    decimals: 0,
    category: 'temps',
    bank: 1,
    priority: 21,
    tooltip: 'Modeled or measured upstream catalytic converter temperature Bank 1. Normal cruise 450–750 °C; >850 °C suggests unburned fuel misfire.',
    decodeBytes: catTemp,
  },
  {
    pidHex: '013D',
    name: 'Catalyst Temp B2S1',
    shortName: 'Cat B2S1',
    unit: '°C',
    min: 0,
    max: 1000,
    decimals: 0,
    category: 'temps',
    bank: 2,
    priority: 30,
    tooltip: 'Upstream catalytic converter temperature Bank 2.',
    decodeBytes: catTemp,
  },
  {
    pidHex: '013E',
    name: 'Catalyst Temp B1S2',
    shortName: 'Cat B1S2',
    unit: '°C',
    min: 0,
    max: 1000,
    decimals: 0,
    category: 'temps',
    bank: 1,
    priority: 22,
    tooltip: 'Downstream catalytic converter temperature Bank 1.',
    decodeBytes: catTemp,
  },
  {
    pidHex: '013F',
    name: 'Catalyst Temp B2S2',
    shortName: 'Cat B2S2',
    unit: '°C',
    min: 0,
    max: 1000,
    decimals: 0,
    category: 'temps',
    bank: 2,
    priority: 31,
    tooltip: 'Downstream catalytic converter temperature Bank 2.',
    decodeBytes: catTemp,
  },
  {
    pidHex: '011F',
    name: 'Run Time Since Engine Start',
    shortName: 'Run Time',
    unit: 's',
    min: 0,
    max: 7200,
    decimals: 0,
    category: 'vehicle',
    bank: null,
    priority: 23,
    tooltip: 'Seconds elapsed since the engine was started. Useful for judging warm-up speed.',
    decodeBytes: b2,
  },
  {
    pidHex: '0121',
    name: 'Distance With MIL On',
    shortName: 'MIL Dist',
    unit: 'km',
    min: 0,
    max: 65535,
    decimals: 0,
    category: 'emissions',
    bank: null,
    priority: 24,
    tooltip: 'Distance driven while the Check Engine Light has been illuminated.',
    decodeBytes: b2,
  },
  {
    pidHex: '0130',
    name: 'Warm-ups Since Codes Cleared',
    shortName: 'Warmups Clr',
    unit: 'cycles',
    min: 0,
    max: 255,
    decimals: 0,
    category: 'emissions',
    bank: null,
    priority: 29,
    tooltip: 'Number of cold-to-warm key cycles since DTCs were last cleared. Very low counts on a used car are a red flag.',
    decodeBytes: b1,
  },
  {
    pidHex: '0131',
    name: 'Distance Since Codes Cleared',
    shortName: 'Dist Clr',
    unit: 'km',
    min: 0,
    max: 65535,
    decimals: 0,
    category: 'emissions',
    bank: null,
    priority: 32,
    tooltip: 'Kilometers driven since trouble codes were last reset. Compare against readiness monitors.',
    decodeBytes: b2,
  },
  {
    pidHex: '014D',
    name: 'Time Run With MIL On',
    shortName: 'MIL Time',
    unit: 'min',
    min: 0,
    max: 65535,
    decimals: 0,
    category: 'emissions',
    bank: null,
    priority: 41,
    tooltip: 'Minutes driven with the Check Engine Light active.',
    decodeBytes: b2,
  },
  {
    pidHex: '014E',
    name: 'Time Since Codes Cleared',
    shortName: 'Time Clr',
    unit: 'min',
    min: 0,
    max: 65535,
    decimals: 0,
    category: 'emissions',
    bank: null,
    priority: 42,
    tooltip: 'Engine run minutes since fault codes were last erased.',
    decodeBytes: b2,
  },
  {
    pidHex: '012F',
    name: 'Fuel Tank Level Input',
    shortName: 'Fuel Lvl',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'fuel',
    bank: null,
    priority: 33,
    tooltip: 'Reported fuel tank fill level percentage.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '015E',
    name: 'Engine Fuel Rate',
    shortName: 'Fuel Rate',
    unit: 'L/h',
    min: 0,
    max: 100,
    decimals: 2,
    category: 'fuel',
    bank: null,
    priority: 34,
    tooltip: 'Direct ECU fuel consumption rate in liters per hour (supported mainly on newer CAN vehicles).',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab / 20;
    },
  },
  {
    pidHex: '015B',
    name: 'Hybrid Battery Pack Life',
    shortName: 'HV Pack SOC',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'hybrid',
    bank: null,
    priority: 35,
    tooltip: 'Hybrid high-voltage battery pack remaining charge/life reported on standard OBD-II.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0103',
    name: 'Fuel System Status Code',
    shortName: 'Fuel Sys',
    unit: 'state',
    min: 0,
    max: 16,
    decimals: 0,
    category: 'fuel',
    bank: null,
    priority: 45,
    tooltip: '1 = Open loop (cold), 2 = Closed loop (using O2 feedback), 4 = Open loop (load/decel), 8 = Fault.',
    decodeBytes: (bytes) => b1(bytes),
  },
  {
    pidHex: '010A',
    name: 'Fuel Pressure (Gauge)',
    shortName: 'Fuel Press',
    unit: 'kPa',
    min: 0,
    max: 765,
    decimals: 0,
    category: 'fuel',
    bank: null,
    priority: 36,
    tooltip: 'Low-side fuel rail gauge pressure (300–450 kPa on typical port-injected vehicles).',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a * 3;
    },
  },
  {
    pidHex: '0122',
    name: 'Fuel Rail Pressure (Rel. Manifold)',
    shortName: 'Rail Rel',
    unit: 'kPa',
    min: 0,
    max: 5177,
    decimals: 1,
    category: 'fuel',
    bank: null,
    priority: 37,
    tooltip: 'Fuel rail pressure relative to intake manifold vacuum.',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab * 0.079;
    },
  },
  {
    pidHex: '0123',
    name: 'Fuel Rail Gauge Pressure (GDI)',
    shortName: 'Rail GDI',
    unit: 'kPa',
    min: 0,
    max: 655350,
    decimals: 0,
    category: 'fuel',
    bank: null,
    priority: 38,
    tooltip: 'High-pressure direct injection fuel rail pressure (often 3,000–20,000 kPa).',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : ab * 10;
    },
  },
  {
    pidHex: '012C',
    name: 'Commanded EGR',
    shortName: 'EGR Cmd',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'emissions',
    bank: null,
    priority: 43,
    tooltip: 'Commanded Exhaust Gas Recirculation valve opening.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '012D',
    name: 'EGR Error',
    shortName: 'EGR Err',
    unit: '%',
    min: -100,
    max: 100,
    decimals: 1,
    category: 'emissions',
    bank: null,
    priority: 44,
    tooltip: 'Difference between commanded and actual EGR flow.',
    decodeBytes: (bytes) => trimPct(bytes),
  },
  {
    pidHex: '012E',
    name: 'Commanded Evap Purge',
    shortName: 'Evap Purge',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'emissions',
    bank: null,
    priority: 46,
    tooltip: 'Duty cycle commanded to the evaporative canister purge solenoid.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0132',
    name: 'Evap System Vapor Pressure',
    shortName: 'Evap Press',
    unit: 'Pa',
    min: -8192,
    max: 8191,
    decimals: 1,
    category: 'emissions',
    bank: null,
    priority: 47,
    tooltip: 'Fuel tank/evap vapor pressure in Pascals (signed 16-bit).',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      if (ab === null) return null;
      const signed = ab > 32767 ? ab - 65536 : ab;
      return signed / 4;
    },
  },
  {
    pidHex: '0143',
    name: 'Absolute Load Value',
    shortName: 'Abs Load',
    unit: '%',
    min: 0,
    max: 400,
    decimals: 1,
    category: 'engine',
    bank: null,
    priority: 39,
    tooltip: 'Normalized air mass per intake stroke relative to standard sea-level cylinder fill (can exceed 100% on boosted engines).',
    decodeBytes: (bytes) => {
      const ab = b2(bytes);
      return ab === null ? null : (ab * 100) / 255;
    },
  },
  {
    pidHex: '0144',
    name: 'Commanded Equivalence Ratio',
    shortName: 'Cmd λ',
    unit: 'λ',
    min: 0.5,
    max: 1.5,
    decimals: 3,
    category: 'fuel',
    bank: null,
    priority: 48,
    tooltip: 'Target air-fuel ratio commanded by the ECU (1.000 = stoich; ~0.85 under full power enrichment).',
    decodeBytes: widebandLambda,
  },
  {
    pidHex: '0145',
    name: 'Relative Throttle Position',
    shortName: 'Rel Thr',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 49,
    tooltip: 'Throttle opening relative to learned closed-throttle stop (near 0% at idle).',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0147',
    name: 'Absolute Throttle Position B',
    shortName: 'Thr B',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 50,
    tooltip: 'Secondary throttle body position sensor for drive-by-wire redundancy.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '0149',
    name: 'Accelerator Pedal Position D',
    shortName: 'Pedal D',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 35,
    tooltip: 'Driver gas pedal sensor D percentage.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '014A',
    name: 'Accelerator Pedal Position E',
    shortName: 'Pedal E',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 51,
    tooltip: 'Secondary driver gas pedal sensor E percentage.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '014C',
    name: 'Commanded Throttle Actuator',
    shortName: 'Thr Cmd',
    unit: '%',
    min: 0,
    max: 100,
    decimals: 1,
    category: 'air',
    bank: null,
    priority: 52,
    tooltip: 'Throttle motor position commanded by the ECU.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : (a * 100) / 255;
    },
  },
  {
    pidHex: '015C',
    name: 'Engine Oil Temperature',
    shortName: 'Oil Temp',
    unit: '°C',
    min: -40,
    max: 160,
    decimals: 0,
    category: 'temps',
    bank: null,
    priority: 34,
    tooltip: 'Engine oil temperature. Warms up more slowly than coolant.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 40;
    },
  },
  {
    pidHex: '0161',
    name: 'Driver Demand Engine Torque',
    shortName: 'Req Trq',
    unit: '%',
    min: -125,
    max: 125,
    decimals: 0,
    category: 'engine',
    bank: null,
    priority: 53,
    tooltip: 'Percent torque requested by the driver.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 125;
    },
  },
  {
    pidHex: '0162',
    name: 'Actual Engine Torque',
    shortName: 'Act Trq',
    unit: '%',
    min: -125,
    max: 125,
    decimals: 0,
    category: 'engine',
    bank: null,
    priority: 54,
    tooltip: 'Actual percent torque delivered by the engine.',
    decodeBytes: (bytes) => {
      const a = b1(bytes);
      return a === null ? null : a - 125;
    },
  },
];

// Calculated PIDs derived from live Mode 01 values
export const CALCULATED_PIDS = [
  {
    pidHex: 'CALC_RPM_SPEED',
    name: 'RPM ÷ Speed Ratio',
    shortName: 'RPM/Speed',
    unit: 'rpm/kmh',
    min: 0,
    max: 120,
    decimals: 1,
    category: 'engine',
    bank: null,
    isCalculated: true,
    dependencies: ['010C', '010D'],
    tooltip: 'Gear & converter/CVT slip indicator. In a fixed gear at steady speed, this ratio stays locked; rising RPM at constant speed indicates slip.',
    compute: (vals) => {
      const rpm = vals['010C'];
      const spd = vals['010D'];
      if (rpm == null || spd == null || spd < 3) return null;
      return rpm / spd;
    },
  },
  {
    pidHex: 'CALC_INST_MPG',
    name: 'Instant Fuel Economy (Est.)',
    shortName: 'Inst MPG',
    unit: 'MPG',
    min: 0,
    max: 60,
    decimals: 1,
    category: 'fuel',
    bank: null,
    isCalculated: true,
    dependencies: ['0110', '010D'],
    tooltip: 'Estimated instantaneous MPG calculated from Mass Air Flow (assuming 14.7:1 gasoline stoich) and vehicle speed.',
    compute: (vals) => {
      const maf = vals['0110'];
      const kmh = vals['010D'];
      if (maf == null || kmh == null || maf <= 0.1 || kmh < 2) return null;
      const mph = kmh * 0.621371;
      const fuelGramsPerSec = maf / 14.7;
      const galPerHour = (fuelGramsPerSec * 3600) / 2800; // ~2800 g per US gal gasoline
      if (galPerHour <= 0) return null;
      const mpg = mph / galPerHour;
      return Math.min(99.9, mpg);
    },
  },
  {
    pidHex: 'CALC_TOTAL_FT_B1',
    name: 'Total Fuel Trim B1 (STFT + LTFT)',
    shortName: 'Total FT B1',
    unit: '%',
    min: -35,
    max: 35,
    decimals: 1,
    category: 'fuel',
    bank: 1,
    isCalculated: true,
    dependencies: ['0106', '0107'],
    tooltip: 'Combined short-term + long-term fuel correction on Bank 1. Total trims beyond ±10% warrant investigation.',
    compute: (vals) => {
      const s = vals['0106'];
      const l = vals['0107'];
      if (s == null || l == null) return null;
      return s + l;
    },
  },
  {
    pidHex: 'CALC_TOTAL_FT_B2',
    name: 'Total Fuel Trim B2 (STFT + LTFT)',
    shortName: 'Total FT B2',
    unit: '%',
    min: -35,
    max: 35,
    decimals: 1,
    category: 'fuel',
    bank: 2,
    isCalculated: true,
    dependencies: ['0108', '0109'],
    tooltip: 'Combined short-term + long-term fuel correction on Bank 2 (V6/V8 engines).',
    compute: (vals) => {
      const s = vals['0108'];
      const l = vals['0109'];
      if (s == null || l == null) return null;
      return s + l;
    },
  },
  {
    pidHex: 'CALC_VAC_BOOST',
    name: 'Intake Vacuum / Boost',
    shortName: 'Vac / Boost',
    unit: 'kPa',
    min: -90,
    max: 160,
    decimals: 0,
    category: 'air',
    bank: null,
    isCalculated: true,
    dependencies: ['010B', '0133'],
    tooltip: 'Manifold gauge pressure (MAP minus Baro). Negative values = engine vacuum (healthy idle ~ -60 to -75 kPa); positive = turbo/supercharger boost.',
    compute: (vals) => {
      const map = vals['010B'];
      const baro = vals['0133'];
      if (map == null || baro == null) return null;
      return map - baro;
    },
  },
];

// Custom PIDs Storage + First-Run CVT/ATF Bootstrap
const CUSTOM_PIDS_KEY = 'bayscope_custom_pids_v1';
const BOOTSTRAP_FLAG_KEY = 'bayscope_custom_pids_bootstrapped_v1';

const DEFAULT_BOOTSTRAP_CUSTOM_PIDS = [
  {
    id: 'CUSTOM_JATCO_CVT',
    name: 'CVT fluid temperature (Jatco)',
    shortName: 'CVT Temp',
    unit: '°C',
    tag: 'trans',
    header: '7E1',
    request: '2101',
    formula: '(A*256+B)/10-40',
    min: -40,
    max: 150,
    decimals: 1,
    unverified: true,
    tooltip: 'unverified — confirm on your car (MX+ likely needed). If it always reads -40 or 215, your vehicle uses a different CAN header or Mode 21/22 PID — delete or edit it in Custom PIDs.',
  },
  {
    id: 'CUSTOM_JATCO_TCC_SLIP',
    name: 'TCC slip / lockup state (Jatco)',
    shortName: 'TCC Slip',
    unit: 'rpm',
    tag: 'trans',
    header: '7E1',
    request: '2103',
    formula: 's16(A,B)',
    min: -200,
    max: 1500,
    decimals: 0,
    unverified: true,
    tooltip: 'unverified — confirm on your car (MX+ likely needed). Placeholder Mode 21 request on TCM header 7E1 for torque converter clutch slip; verify address on your model year.',
  },
  {
    id: 'CUSTOM_TOYOTA_ATF',
    name: 'ATF temperature (Toyota)',
    shortName: 'ATF Temp',
    unit: '°C',
    tag: 'trans',
    header: '7E0',
    request: '2101',
    formula: '(A*256+B)/10-40',
    min: -40,
    max: 150,
    decimals: 1,
    unverified: true,
    tooltip: 'unverified — confirm on your car. Some Toyotas use header 7E0 or 7E1 with request 2182 or 21D9; delete if it reads -40 or 215.',
  },
];

export function loadCustomPids() {
  try {
    if (!localStorage.getItem(BOOTSTRAP_FLAG_KEY)) {
      localStorage.setItem(CUSTOM_PIDS_KEY, JSON.stringify(DEFAULT_BOOTSTRAP_CUSTOM_PIDS));
      localStorage.setItem(BOOTSTRAP_FLAG_KEY, '1');
      return hydrateCustomPids(DEFAULT_BOOTSTRAP_CUSTOM_PIDS);
    }
    const raw = localStorage.getItem(CUSTOM_PIDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? hydrateCustomPids(parsed) : [];
  } catch {
    return hydrateCustomPids(DEFAULT_BOOTSTRAP_CUSTOM_PIDS);
  }
}

export function saveCustomPids(list) {
  const clean = list.map((p) => ({
    id: p.id,
    name: p.name,
    shortName: p.shortName,
    unit: p.unit,
    tag: p.tag || 'other',
    header: (p.header || '').toUpperCase(),
    request: (p.request || '').toUpperCase(),
    formula: p.formula,
    min: Number.isFinite(Number(p.min)) ? Number(p.min) : 0,
    max: Number.isFinite(Number(p.max)) ? Number(p.max) : 100,
    decimals: Number.isFinite(Number(p.decimals)) ? Number(p.decimals) : 1,
    unverified: Boolean(p.unverified),
    tooltip: p.tooltip || '',
  }));
  localStorage.setItem(CUSTOM_PIDS_KEY, JSON.stringify(clean));
  return hydrateCustomPids(clean);
}

function hydrateCustomPids(rawList) {
  return rawList.map((item) => {
    let compiled = null;
    try {
      compiled = compileFormula(item.formula);
    } catch {
      compiled = null;
    }
    return {
      ...item,
      pidHex: item.id,
      isCustom: true,
      bank: null,
      priority: 60,
      decodeBytes: (bytes) => {
        if (!compiled) return null;
        return compiled.evaluate(bytes);
      },
    };
  });
}

export function getAllPidsMap(customPids = []) {
  const map = new Map();
  for (const p of STANDARD_PIDS) map.set(p.pidHex, p);
  for (const p of CALCULATED_PIDS) map.set(p.pidHex, p);
  for (const p of customPids) map.set(p.pidHex, p);
  return map;
}

// Display unit conversion (canonical internal & CSV storage stays metric °C / km/h / km / kPa unless converted cleanly)
export function formatDisplayValue(pid, rawValue, useImperial) {
  if (rawValue === null || rawValue === undefined || !Number.isFinite(rawValue)) {
    return { text: '—', unit: pid.unit, displayVal: null, displayMin: pid.min, displayMax: pid.max };
  }
  let val = rawValue;
  let unit = pid.unit;
  let min = pid.min;
  let max = pid.max;
  let decimals = pid.decimals;

  if (useImperial) {
    if (pid.unit === '°C') {
      val = (rawValue * 9) / 5 + 32;
      min = (pid.min * 9) / 5 + 32;
      max = (pid.max * 9) / 5 + 32;
      unit = '°F';
    } else if (pid.unit === 'km/h') {
      val = rawValue * 0.621371;
      min = 0;
      max = pid.max * 0.621371;
      unit = 'mph';
    } else if (pid.unit === 'km') {
      val = rawValue * 0.621371;
      min = 0;
      max = pid.max * 0.621371;
      unit = 'mi';
    } else if (pid.unit === 'kPa') {
      val = rawValue * 0.145038;
      min = pid.min * 0.145038;
      max = pid.max * 0.145038;
      unit = 'psi';
      decimals = Math.max(1, pid.decimals);
    } else if (pid.unit === 'L/h') {
      val = rawValue * 0.264172;
      min = 0;
      max = pid.max * 0.264172;
      unit = 'gal/h';
    } else if (pid.unit === 'rpm/kmh') {
      val = rawValue / 0.621371;
      min = 0;
      max = pid.max / 0.621371;
      unit = 'rpm/mph';
    }
  }

  return {
    text: val.toFixed(decimals),
    unit,
    displayVal: val,
    displayMin: min,
    displayMax: max,
  };
}
