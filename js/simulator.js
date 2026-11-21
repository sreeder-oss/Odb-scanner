// Physics-inspired vehicle OBD-II simulator for testing and demo use without a car.
// All data produced here is explicitly marked simulated=true.

export const SIM_SCENARIOS = [
  {
    id: 'healthy_cruise',
    name: 'Healthy warm city/highway drive',
    vin: 'JTEBU5JR5K5642190',
    mfrId: 'toyota',
    engineId: '1GR-FE',
    transId: '5AT (A750)',
    dtcs: { stored: [], pending: [], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'general',
    description: '4Runner 4.0L V6 warming up cleanly with balanced fuel trims (±2%).',
  },
  {
    id: 'lean_vacuum',
    name: 'Vacuum leak — Lean Bank 1 & 2 (P0171/P0174)',
    vin: '5N1DR2MM5KC619822',
    mfrId: 'nissan',
    engineId: 'VQ35DE',
    transId: 'Jatco CVT (RE0F10E/JF017E)',
    dtcs: { stored: ['P0171', 'P0174'], pending: ['P0171'], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'fuel',
    description: 'High positive trims (+16–22% at idle, improving at cruise) — classic intake boot leak.',
  },
  {
    id: 'thermostat_p0128',
    name: 'Stuck-open thermostat (P0128)',
    vin: '2T3BFREV8FW312044',
    mfrId: 'toyota',
    engineId: '2AR-FE',
    transId: '6AT (U760)',
    dtcs: { stored: ['P0128'], pending: [], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'warmup',
    description: 'Coolant stalls around 66–71 °C even after 10+ minutes of driving.',
  },
  {
    id: 'misfire_p0303',
    name: 'Cylinder 3 misfire & rough idle (P0303)',
    vin: 'JTEBU5JR5K5642190',
    mfrId: 'toyota',
    engineId: '1GR-FE',
    transId: '5AT (A750)',
    dtcs: { stored: ['P0303'], pending: ['P0300'], permanent: ['P0303'] },
    recentClear: false,
    recommendedProfileId: 'misfire',
    description: 'Erratic idle RPM dips, retarded timing, negative Bank 1 trim from unburned O2.',
  },
  {
    id: 'cat_p0420',
    name: 'Weak catalytic converter (P0420)',
    vin: '1N4AL3AP7JC248105',
    mfrId: 'nissan',
    engineId: 'QR25DE',
    transId: 'Jatco CVT',
    dtcs: { stored: ['P0420'], pending: [], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'catalyst',
    description: 'Downstream B1S2 O2 sensor swings almost in lockstep with upstream B1S1.',
  },
  {
    id: 'jatco_cvt_judder',
    name: 'Jatco CVT low-speed judder — VQ35DE (No DTCs)',
    vin: '5N1DR2MM5KC619822',
    mfrId: 'nissan',
    engineId: 'VQ35DE',
    transId: 'Jatco CVT (RE0F10E/JF017E)',
    dtcs: { stored: [], pending: [], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'cvt_judder_jatco',
    description: '15–25 mph light-throttle shudder on Nissan VQ35DE + Jatco RE0F10E/JF017E with zero DTCs: slight RPM/Speed hunting, STFT oscillation, and timing wobble.',
  },
  {
    id: 'trans_p0730',
    name: 'Transmission / CVT slip & heat (P0730)',
    vin: '5N1DR2MM5KC619822',
    mfrId: 'nissan',
    engineId: 'VQ35DE',
    transId: 'Jatco CVT (RE0F10E/JF017E)',
    dtcs: { stored: ['P0730'], pending: ['P0746'], permanent: [] },
    recentClear: false,
    recommendedProfileId: 'transmission',
    description: 'RPM flares up relative to speed under moderate throttle; CVT temp climbs toward 118 °C.',
  },
  {
    id: 'recent_clear',
    name: 'Suspicious recently cleared seller car',
    vin: '4T1BF1FK3HU712390',
    mfrId: 'toyota',
    engineId: '2AR-FE',
    transId: '6AT (U760)',
    dtcs: { stored: [], pending: ['P0420'], permanent: ['P0420'] },
    recentClear: true,
    recommendedProfileId: 'pre_purchase',
    description: '0 stored codes, 14 km and 1 warm-up since clear, incomplete Catalyst/Evap monitors, permanent P0420 still present.',
  },
];

export class VehicleSimulator {
  constructor(scenarioId = 'healthy_cruise') {
    this.setScenario(scenarioId);
    this.startTime = Date.now();
    this.lastTick = Date.now();
    this.coolant = 32;
    this.catTemp = 280;
    this.cvtTemp = 54;
    this.fuelLevel = 68;
    this.hvSoc = 62;
  }

  setScenario(id) {
    this.scenario = SIM_SCENARIOS.find((s) => s.id === id) || SIM_SCENARIOS[0];
    this.dtcsCleared = false;
  }

  clearDtcs() {
    this.dtcsCleared = true;
  }

  getInfo() {
    const s = this.scenario;
    const cleared = Boolean(this.dtcsCleared);
    const stored = cleared ? [] : [...s.dtcs.stored];
    const pending = cleared ? [] : [...s.dtcs.pending];
    const permanent = [...s.dtcs.permanent];
    return {
      vin: s.vin,
      make: s.mfrId === 'toyota' ? 'Toyota' : 'Nissan / Infiniti',
      year: 2018,
      milOn: stored.length > 0,
      dtcCount: stored.length,
      ignitionType: 'Spark (Gasoline / Hybrid)',
      monitors: [
        { name: 'Misfire', supported: true, ready: !cleared },
        { name: 'Fuel System', supported: true, ready: !cleared },
        { name: 'Components', supported: true, ready: !cleared },
        { name: 'Catalyst', supported: true, ready: !cleared && !s.recentClear },
        { name: 'Evap System', supported: true, ready: !cleared && !s.recentClear },
        { name: 'O2 Sensor', supported: true, ready: !cleared && !s.recentClear },
        { name: 'O2 Sensor Heater', supported: true, ready: !cleared },
      ],
      distanceWithMil: stored.length > 0 ? 184 : 0,
      warmupsSinceClear: cleared ? 0 : (s.recentClear ? 1 : 47),
      distanceSinceClear: cleared ? 0 : (s.recentClear ? 14 : 1840),
      timeWithMil: stored.length > 0 ? 215 : 0,
      timeSinceClear: cleared ? 0 : (s.recentClear ? 18 : 2410),
      dtcs: { stored, pending, permanent },
    };
  }

  getSupportedPids() {
    return [
      '0103', '0104', '0105', '0106', '0107', '0108', '0109', '010B', '010C', '010D',
      '010E', '010F', '0110', '0111', '0114', '0115', '011F', '0121', '0124', '0125',
      '012F', '0130', '0131', '0133', '013C', '013E', '0142', '0144', '0145', '0146',
      '0149', '014D', '014E', '015B', '015E',
    ];
  }

  sample() {
    const now = Date.now();
    const t = (now - this.startTime) / 1000;
    const dt = Math.min(1, (now - this.lastTick) / 1000);
    this.lastTick = now;

    // Drive cycle wave: idle -> city accel -> cruise -> decel
    const phase = t % 45;
    let targetSpeed = 0;
    let throttle = 13.5;
    if (phase < 8) {
      targetSpeed = 0;
      throttle = 13.2;
    } else if (phase < 18) {
      targetSpeed = ((phase - 8) / 10) * 68;
      throttle = 34 + Math.sin(t * 1.1) * 6;
    } else if (phase < 34) {
      targetSpeed = 68 + Math.sin((phase - 18) * 0.4) * 10;
      throttle = 24 + Math.sin(t * 0.7) * 3;
    } else {
      targetSpeed = Math.max(0, 68 * (1 - (phase - 34) / 11));
      throttle = 12.5;
    }

    const speed =
      this.scenario.id === 'jatco_cvt_judder' && phase >= 10 && phase <= 32
        ? 34 + Math.sin(t * 0.4) * 3 // ~21 mph (34 km/h) steady judder window
        : Math.max(0, targetSpeed + (Math.random() - 0.5) * 1.2);
    let rpm = speed < 2 ? 710 + (Math.random() - 0.5) * 28 : 1150 + speed * 26 + (throttle - 20) * 18;
    if (this.scenario.id === 'misfire_p0303' && speed < 3) {
      rpm += Math.sin(t * 7.5) * 95 - 40;
    }
    if (this.scenario.id === 'trans_p0730' && phase >= 10 && phase <= 26) {
      rpm += 720; // flare/slip under load
    }
    if (this.scenario.id === 'jatco_cvt_judder' && speed >= 22 && speed <= 44) {
      // 15-25 mph light-throttle judder window: hunting + TCC partial lockup oscillation
      rpm += Math.sin(t * 6.5) * 140 + (Math.random() - 0.5) * 45;
    }

    const load = Math.min(95, Math.max(14, throttle * 1.6 + (speed > 2 ? 12 : 4) + (Math.random() - 0.5) * 2));
    const map = Math.min(101, Math.max(26, 26 + (throttle - 12) * 1.45));
    const baro = 100.8;
    const maf = Math.max(2.6, (rpm / 1000) * (map / 100) * 5.2);

    // Coolant warm-up
    const coolantTarget = this.scenario.id === 'thermostat_p0128' ? 68 : 91;
    this.coolant += (coolantTarget - this.coolant) * dt * 0.045;
    const catTarget = 420 + load * 3.8;
    this.catTemp += (catTarget - this.catTemp) * dt * 0.08;
    const cvtTarget = this.scenario.id === 'trans_p0730' ? 119 : this.scenario.id === 'jatco_cvt_judder' ? 92 : 82;
    this.cvtTemp += (cvtTarget - this.cvtTemp) * dt * 0.03;

    // Fuel trims
    let stft1 = (Math.random() - 0.5) * 3.2;
    let ltft1 = 1.6;
    let stft2 = (Math.random() - 0.5) * 3.2;
    let ltft2 = 1.4;
    if (this.scenario.id === 'lean_vacuum') {
      const idleFactor = speed < 5 ? 1 : 0.45;
      stft1 = 7.5 * idleFactor + (Math.random() - 0.5) * 2.5;
      ltft1 = 14.8;
      stft2 = 6.8 * idleFactor + (Math.random() - 0.5) * 2.5;
      ltft2 = 13.5;
    } else if (this.scenario.id === 'misfire_p0303') {
      stft1 = -6.5 + (Math.random() - 0.5) * 3;
      ltft1 = -4.2;
    } else if (this.scenario.id === 'jatco_cvt_judder' && speed >= 22 && speed <= 44) {
      stft1 = Math.sin(t * 5.2) * 11.5 + (Math.random() - 0.5) * 2.0;
      stft2 = Math.sin(t * 5.2 + 0.3) * 10.5 + (Math.random() - 0.5) * 2.0;
    }

    // O2 sensors
    const o2b1s1 = 0.45 + 0.36 * Math.sin(t * 4.2);
    const o2b1s2 = this.scenario.id === 'cat_p0420'
      ? 0.44 + 0.31 * Math.sin(t * 4.0 - 0.3) // mirrors B1S1
      : 0.71 + 0.03 * Math.sin(t * 0.6);

    const lambda1 = 1.0 + (stft1 < 0 ? -0.02 : 0.015) + (Math.random() - 0.5) * 0.012;
    let timing = speed < 2 ? (this.scenario.id === 'misfire_p0303' ? 5.5 : 13.5) : 22 + (throttle < 25 ? 8 : -4);
    if (this.scenario.id === 'jatco_cvt_judder' && speed >= 22 && speed <= 44) {
      timing += Math.sin(t * 6.0) * 5.5;
    }
    const voltage = 14.15 + (Math.random() - 0.5) * 0.14;
    const fuelRate = (maf / 14.7) * 3600 / 740;
    this.fuelLevel = Math.max(5, this.fuelLevel - dt * 0.002);
    this.hvSoc = 58 + Math.sin(t * 0.12) * 8;
    const tccSlip = this.scenario.id === 'jatco_cvt_judder' && speed >= 22 && speed <= 44
      ? 95 + Math.sin(t * 6.5) * 65
      : speed < 15 ? 450 : 12;

    return {
      '010C': rpm,
      '010D': speed,
      '0104': load,
      '0105': this.coolant,
      '0106': stft1,
      '0107': ltft1,
      '0108': stft2,
      '0109': ltft2,
      '010B': map,
      '010E': timing,
      '010F': 24 + Math.sin(t * 0.05) * 2,
      '0110': maf,
      '0111': throttle,
      '0114': o2b1s1,
      '0115': o2b1s2,
      '011F': Math.round(t + 120),
      '0121': this.scenario.dtcs.stored.length > 0 ? 184 : 0,
      '0124': lambda1,
      '0125': 1.002,
      '012F': this.fuelLevel,
      '0130': this.scenario.recentClear ? 1 : 47,
      '0131': this.scenario.recentClear ? 14 : 1840,
      '0133': baro,
      '013C': this.catTemp,
      '013E': this.catTemp - 48,
      '0142': voltage,
      '0144': 1.0,
      '0145': Math.max(0, throttle - 12),
      '0146': 19,
      '0149': Math.max(0, throttle - 10),
      '014D': this.scenario.dtcs.stored.length > 0 ? 215 : 0,
      '014E': this.scenario.recentClear ? 18 : 2410,
      '015B': this.hvSoc,
      '015E': fuelRate,
      CUSTOM_JATCO_CVT: this.cvtTemp,
      CUSTOM_JATCO_TCC_SLIP: tccSlip,
      CUSTOM_TOYOTA_ATF: this.cvtTemp - 4,
    };
  }
}
