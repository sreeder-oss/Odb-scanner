// BayScope In-App Field Guide — Plain-English Chapters & Metadata

export const VIEW_LABELS = {
  dashboard: 'Dashboard',
  variables: 'Variables',
  presets: 'Scan targets',
  vehicle: 'Vehicle profile',
  dtcs: 'Trouble codes',
  'custom-pids': 'Custom PIDs',
  terminal: 'Terminal log',
  export: 'Data & export',
  ai: 'AI Assistant',
  settings: 'Settings',
  about: 'About',
};

export const GUIDE_CHAPTERS = [
  {
    id: 'quickstart',
    number: '01',
    title: 'Quick Start & Cold Starts',
    shortLabel: 'Quick Start',
    relatedView: 'dashboard',
    keywords: 'plug in obd-ii koeo key on engine off cranking cold start capture creep t=0 vibration dongle ble serial classic bluetooth',
    whatItDoes:
      'Walks you through connecting BayScope to an ELM327 Bluetooth (BLE or Classic SPP) or USB adapter—and sets up true cold-start captures so the very first second of engine cranking is recorded.',
    whenToUse:
      'Every time you start a session, especially before an overnight cold soak when chasing cold-start stumbles, CVT judder, or creep shudder.',
    steps: [
      'Plug your ELM327 adapter firmly into the OBD-II port under the dash. Loose ports are the #1 cause of mid-drive disconnects—snug it down or add a dab of zip-tie/velcro support if road bumps knock it loose.',
      'Turn the ignition key to ON (Key On, Engine Off — KOEO) to power the ECU without starting the engine. Note: KOEO lets you connect, arm your capture, and read VIN/DTCs; Engine Running is required for live RPM above 0 and fuel trim movement.',
      'Before cranking, pre-select your Scan Target or tap "Cold start / creep capture" on the Start Here card, then connect your adapter (BLE, Classic / USB, or Reconnect saved scanner).',
      'As soon as live data connects, start the engine immediately so t=0 records cranking, initial flare, and cold idle.',
      'Pro tip: Classic Bluetooth (~$20 clones) must be paired in your phone or OS Bluetooth settings first (PIN is usually 1234 or 0000), then opened via "Connect: Classic / USB".',
    ],
  },
  {
    id: 'dashboard',
    number: '02',
    title: 'Dashboard & Live Gauges',
    shortLabel: 'Dashboard',
    relatedView: 'dashboard',
    keywords: 'live gauges min max bar plot trace chart scan target switcher mark moment shudder symptom session tools',
    whatItDoes:
      'Displays real-time sensor readings as clean numeric cards with range bars, session min/max memory, a live multi-line trace chart, and one-tap event marking.',
    whenToUse:
      'During parked warm-ups, test drives (with a passenger watching the screen), or simulator practice to watch live engine and transmission behavior.',
    steps: [
      'Each gauge card shows the live number, its unit, a visual bar across its typical range, and the lowest/highest value seen since the session started (min / max). Tap "?" on any card for plain-English context.',
      'Tap "Plot" on up to 4 gauges to graph them together in the Live Trace chart. Each line scales independently to its own range so RPM (0–7000) and STFT (−25% to +25%) stay readable side by side.',
      'Use the Scan Target dropdown right in the live toolbar to switch diagnostic profiles (e.g., General Health → CVT Judder) without leaving the dashboard.',
      'Tap "Mark shudder / symptom" (one tap, no typing) or type a custom label into "Mark moment" whenever you feel a hesitation, stumble, or judder—it stamps that exact row in the CSV for later review.',
      'Pro tip: Secondary panels like Drive Script and CVT Service Checklist start collapsed while live so your gauges stay front and center; tap their header button whenever you want to expand them.',
    ],
  },
  {
    id: 'variables',
    number: '03',
    title: 'Variables',
    shortLabel: 'Variables',
    relatedView: 'variables',
    keywords: 'pid mode 01 calculated rpm speed slip ratio total ft b1 b2 inst mpg vac boost supported your car clone 6 pid cap',
    whatItDoes:
      'Lets you browse, search, and toggle all ~53 standard SAE Mode 01 sensors, 5 calculated diagnostic metrics, and any custom PIDs onto your dashboard.',
    whenToUse:
      'When you want to customize which gauges are polled, verify which sensors your specific ECU supports, or trim unnecessary sensors to speed up logging.',
    steps: [
      'Standard Mode 01 PIDs (like 010C Engine RPM or 0106 STFT B1) are requested directly from your car\'s ECU. Calculated PIDs—including RPM/Speed ratio, Total Fuel Trim B1/B2, Instant MPG, and Vacuum/Boost—compute automatically from those base PIDs.',
      'Look for the green "your car ✓" badge after connecting: BayScope reads your ECU\'s supported-PID bitmasks (0100, 0120, 0140) so you know which sensors the car actually answers.',
      'Filter by "On Dashboard", "Your car ✓", "Calculated", or "Custom", or search by name, hex code (e.g. 010C), or unit.',
      'Why clones cap at 6 PIDs: Every extra PID adds another serial round-trip. Cheap ELM327 v1.3a clones need 150 ms+ spacing between commands, so polling 10 PIDs drops your log below 0.6 Hz—too slow to catch a 1-second judder. Capping at 4–6 PIDs keeps sample rate usable (fast STN/OBDLink adapters raise the cap to 20).',
    ],
  },
  {
    id: 'presets',
    number: '04',
    title: 'Scan Targets',
    shortLabel: 'Scan Targets',
    relatedView: 'presets',
    keywords: 'profiles symptom maintenance code cvt judder jatco tcc lockup belt slip drive script custom profile builder',
    whatItDoes:
      'Groups curated diagnostic profiles—each bundling a targeted PID list, step-by-step drive script, and tailored AI analysis prompt—so one click configures your entire test drive.',
    whenToUse:
      'Before any symptom hunt, routine health check, pre-purchase test drive, or after trouble codes appear (BayScope also auto-matches profiles when DTCs are found).',
    steps: [
      'Filter profiles by Symptom, Maintenance, Code, or Custom, and tap "Load on dashboard" (or pick them straight from the Dashboard Scan Target dropdown).',
      'CVT Judder workflow: Logs a lean, fast set (RPM, Speed, Load, STFT B1, Coolant) to keep sample rate high. Hold steady 15–25 mph light throttle in the judder window, then feather and slightly lift the throttle—if shudder vanishes immediately on lift, it points strongly toward torque-converter clutch (TCC) lockup shudder rather than continuous belt slip.',
      'Use the optional warm-swap button inside the expanded Drive Script once coolant reaches 80 °C+ to drop Coolant (0105) and run an even faster 4-PID capture.',
      'Tap "+ New custom profile" to save your own PID list, drive steps, and AI prompt for repeat diagnostics on your vehicle.',
    ],
  },
  {
    id: 'vehicle',
    number: '05',
    title: 'Vehicle Profile & Garage',
    shortLabel: 'Vehicle & Garage',
    relatedView: 'vehicle',
    keywords: 'manufacturer engine transmission combo auto-save layout bank 2 4-cylinder vin 17-character garage restore',
    whatItDoes:
      'Stores your Manufacturer, Engine, and Transmission metadata, applies Bank 2 visibility rules, and saves named vehicles by 17-character VIN in your local Garage.',
    whenToUse:
      'When switching cars, setting up a new vehicle for the first time, or saving your daily driver so BayScope remembers its custom gauge layout automatically.',
    steps: [
      'Choose your Manufacturer, Engine, and Transmission. Your active dashboard PID layout and plotted chart lines auto-save per vehicle combination.',
      'Bank 2 rule: Single-bank inline-4 engines automatically hide Bank 2 fuel trim and O2 sensors so your catalog stays clean. Check "Show Bank 2 variables on single-bank engines" only if you need to force them visible.',
      'Add your car to "My vehicles garage" with a nickname and its 17-character VIN (auto-filled when the ECU returns Mode 09 02).',
      'Next time you plug into that car, BayScope matches the VIN and restores your vehicle profile and saved gauge layout automatically.',
    ],
  },
  {
    id: 'dtcs',
    number: '06',
    title: 'Trouble Codes & Readiness',
    shortLabel: 'Trouble Codes',
    relatedView: 'dtcs',
    keywords: 'dtc stored mode 03 pending mode 07 permanent mode 0a clear mode 04 mil check engine readiness monitors emissions clear distance 80 km warm-ups used car koeo',
    whatItDoes:
      'Reads Stored, Pending, and Permanent OBD-II trouble codes alongside emissions readiness monitors and clear-history counters—and offers a confirmation-gated Mode 04 clear when you are ready to verify a repair.',
    whenToUse:
      'Whenever a Check Engine Light (MIL) turns on, during a pre-purchase inspection of a used car, or after completing a repair to turn off the MIL and verify the fix.',
    steps: [
      'Stored (Mode 03) codes have already triggered a fault/MIL. Pending (Mode 07) codes failed on one drive cycle and are waiting for confirmation. Permanent (Mode 0A) codes stay locked in the ECU until the car itself verifies the repair across drive cycles.',
      'Reading codes in BayScope NEVER clears them—your freeze-frame history and readiness monitors stay completely untouched.',
      'When to use Clear codes (Mode 04): After fixing a problem, clearing lets you turn off the Check Engine Light and verify the repair immediately instead of waiting ~3 complete drive cycles for the MIL to self-extinguish. Always clear with Key ON, Engine OFF (parked safely) — many ECUs reject Mode 04 while the engine is running.',
      'Mode 04 resets all Emissions Readiness Monitors to Incomplete (which fails smog/emissions testing until driven through full drive cycles) and does NOT erase Permanent (Mode 0A) codes—only verified clean driving clears Mode 0A codes.',
      'Used-car warning: BayScope flags a red alert if Distance Since Codes Cleared is under 80 km or Warm-ups Since Cleared is under 5—a strong sign someone cleared the Check Engine Light right before showing the car.',
    ],
  },
  {
    id: 'custom-pids',
    number: '07',
    title: 'Custom PIDs',
    shortLabel: 'Custom PIDs',
    relatedView: 'custom-pids',
    keywords: 'mode 21 mode 22 header 7e1 jatco cvt fluid temp tcc slip formula bytes a-h s8 s16 unverified -40 215',
    whatItDoes:
      'Lets advanced users define manufacturer-specific Mode 21/22 requests with custom 3-digit CAN headers and safe mathematical byte formulas.',
    whenToUse:
      'When you need powertrain data outside standard OBD-II—such as Jatco CVT fluid temperature or torque-converter slip on transmission module header 7E1 (typically requires a capable adapter like OBDLink MX+).',
    steps: [
      'Enter the 3-hex-digit CAN Header (e.g., 7E1 for many Nissan/Infiniti TCMs, 7E0 for ECM) and the Hex Request (e.g., 2101 or 22F405). Non-01xx requests always require a 3-digit header.',
      'Write a formula using response bytes A–H and safe helpers: +, -, *, /, parentheses, s8(A), s16(A,B), min(), max(), and abs(). The live validator tests your syntax against sample bytes before saving.',
      'Confirm every "unverified" custom PID on your own vehicle before trusting it: automakers move Mode 21/22 addresses between model years.',
      'Pro tip: If a custom PID stays frozen at nonsense values like -40 °C or 215 °C (raw 0x00 or 0xFF), remove it from your dashboard so it doesn\'t waste polling bandwidth or confuse AI analysis.',
    ],
  },
  {
    id: 'terminal',
    number: '08',
    title: 'Terminal Log',
    shortLabel: 'Terminal Log',
    relatedView: 'terminal',
    keywords: 'ati atdpn baud probing 38400 115200 9600 57600 raw command at 0100 tx rx copy report troubleshooting',
    whatItDoes:
      'Streams raw TX/RX serial frames, adapter identity (ATI), active protocol (ATDPN), baud-rate probing, and resync events—and lets you send manual commands.',
    whenToUse:
      'When troubleshooting a stubborn adapter, confirming whether your dongle is a fast STN chip or an ELM327 v1.3a clone, or testing a single raw PID manually.',
    steps: [
      'Check the top metadata strip: ATI shows your adapter firmware identity (e.g., ELM327 v1.5 or STN1170), and ATDPN shows the negotiated vehicle protocol number.',
      'On Classic/USB connections, BayScope automatically probes baud rates in order (38400 → 115200 → 9600 → 57600) until the adapter answers cleanly—you can watch each attempt in the log.',
      'Use the bottom command bar to send manual commands like ATI (identity), ATRV (battery voltage), or 0100 (supported PIDs) while connected.',
      'Tap "Copy report" to copy a formatted connection log (timestamp, ATI, ATDPN, and TX/RX trace) for debugging or pasting into an AI chat.',
    ],
  },
  {
    id: 'export',
    number: '09',
    title: 'Data & Export',
    shortLabel: 'Data & Export',
    relatedView: 'export',
    keywords: 'memory only download csv reload full csv ai-sized 1.5 hz 600 rows marked moments known-good baseline compare ai prompt',
    whatItDoes:
      'Exports your recorded drive as raw or AI-sized CSV files, manages Known-Good Vehicle Baselines, and builds a ready-to-paste diagnostic prompt with full session stats.',
    whenToUse:
      'Immediately after every test drive—before closing or reloading the browser tab—to archive your data or upload it to an AI model.',
    steps: [
      'Important: Session telemetry lives in browser memory only and is cleared if you refresh or close the tab. Download your CSV right after parking (BayScope also auto-saves a partial CSV snapshot if the adapter unexpectedly detaches).',
      'Full CSV exports every single polled row for spreadsheets or deep analysis. AI CSV downsamples cleanly to ~1.5 Hz (capped at 600 rows) while preserving 100% of your marked moments so it fits cleanly into LLM context windows.',
      'Save a Known-Good Vehicle Baseline after a healthy drive: future sessions for that VIN/vehicle profile automatically calculate before-vs-after deltas and switch the AI prompt into baseline-comparison mode.',
      'Add your symptoms and test-drive notes, choose "Own vehicle diagnosis" or "Buying / test drive", then tap "Copy AI Prompt" to paste directly into Claude, Gemini, or ChatGPT.',
    ],
  },
  {
    id: 'ai',
    number: '10',
    title: 'AI Assistant',
    shortLabel: 'AI Assistant',
    relatedView: 'ai',
    keywords: 'byok api key anthropic claude google gemini openrouter deepseek v4.1 flash local browser presets analyze log attach summary csv',
    whatItDoes:
      'Provides a direct browser-to-provider Bring-Your-Own-Key (BYOK) diagnostic chat grounded in your live vehicle profile, trouble codes, session statistics, and marked moments.',
    whenToUse:
      'When you want instant interpretation of your live drive, fuel trim patterns, CVT judder windows, or a used-car inspection without leaving BayScope.',
    steps: [
      'Open Settings → AI Assistant, select Anthropic (Claude), Google (Gemini), or OpenRouter (DeepSeek V4.1 Flash), choose your model, and paste your personal API key. Your key stays strictly in this browser\'s localStorage and is never exported.',
      'Acknowledge the one-time privacy notice (requests travel directly from your device to your chosen AI provider).',
      'Tap a one-click preset—"Analyze this log", "Used-car assessment", "Explain these codes", or "What should I log next?"—or type your own question.',
      'Before sending, tap "Attach full log summary" for compact min/avg/max tables, or "Send full CSV to AI" to include the AI-sized (~1.5 Hz) time-series CSV.',
    ],
  },
  {
    id: 'settings',
    number: '11',
    title: 'Settings & Adapter Limits',
    shortLabel: 'Settings & Limits',
    relatedView: 'settings',
    keywords: 'metric imperial units csv canonical headers wake lock screen awake tx delay 150 ms backoff desync wifi adapter unsupported https chrome edge',
    whatItDoes:
      'Controls display units, screen wake lock, ELM327 command pacing, PWA installation, and BYOK AI credentials—plus documents real browser hardware limits.',
    whenToUse:
      'To switch gauges to °F/mph/psi, keep your phone screen awake during drives, or tune inter-command delay for a finicky ELM327 clone.',
    steps: [
      'Display units: Switch freely between Metric (°C, km/h, kPa) and Imperial (°F, mph, psi) for dashboard gauges. CSV exports always preserve canonical metric header units so AI tools and spreadsheets stay consistent.',
      'Keep screen awake: Enables the browser Wake Lock API during live sessions so your phone won\'t dim mid-test-drive.',
      'ELM327 TX delay: Defaults to 150 ms (100 ms minimum) for standard adapters and automatically backs off (200 ms → 300 ms) if a clone desyncs. Fast STN/OBDLink adapters switch to their fast profile automatically.',
      'Adapter & browser limits: Requires HTTPS in Chrome or Edge (desktop or Android). Wi-Fi ELM327 adapters are unsupported because web browsers cannot open raw TCP sockets to 192.168.0.10. iOS Safari supports Simulator and log review only.',
    ],
  },
];
