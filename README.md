# BayScope

A single-page OBD-II dashboard for Toyota, Nissan, and generic vehicles. Pick
exactly which variables you want on screen (up to 10), tune the list to what
you're diagnosing, and log the session.

**Live page:** https://sreeder-oss.github.io/Odb-scanner/

## Features

- **Menu** with Dashboard, Variables, Scan targets, Vehicle profile, Trouble
  codes, Custom PIDs, Terminal log, Data & export, Settings.
- **Variable picker** — ~50 standard (SAE J1979 Mode 01) variables plus
  calculated ones, searchable and grouped. Add or remove up to 10 dashboard
  gauges. Bank-2 / hybrid variables are hidden unless your engine needs them.
- **Vehicle profile** — manufacturer → engine → transmission. Each combination
  remembers its own dashboard layout.
- **Scan targets** — one-tap presets (lean/rich, misfire, warm-up/thermostat,
  transmission, catalyst, economy, hybrid, general health).
- **"Your car reports ✓"** — reads the car's own supported-PID list so the
  picker shows what will actually answer.
- **Calculated variables** — RPM÷speed ratio (shows gear/slip behaviour on any
  car) and estimated instant MPG.
- **Custom PIDs** — add manufacturer-specific (enhanced) variables with a
  request, a CAN header, and a formula. Formulas are parsed by a small safe
  evaluator (no `eval`).
- **Trouble codes** — stored (03), pending (07), permanent (0A). Read-only; it
  never clears codes.
- **Pre-purchase test drive** preset — RPM, speed, load, coolant, fuel trims,
  voltage and RPM÷speed ratio, for evaluating a used car on a drive.
- **Vehicle info on connect** — reads the VIN (Mode 09), decodes make and likely
  model year, then reads check-engine light, readiness monitors, distance and
  warm-ups since codes were cleared, and all three trouble-code lists. Flags
  signs codes were recently cleared. Toyota/Nissan VINs switch the profile for
  you; engine and transmission are still picked by hand.
- **Terminal** with a raw command box for exploring your car.
- CSV export with a `#`-commented vehicle header (VIN, codes, readiness, reset
  history), an elapsed-seconds column, units in headers and simulated rows
  flagged; a "copy AI prompt" tuned for buy / negotiate / walk-away advice; and
  settings backup/restore.
- Simulation mode for trying the UI with no car. Its data is always labelled
  as fake.

## Read this before using it in a car

The standard-PID polling, supported-PID scan, VIN/readiness read, and
trouble-code reader are implemented, but were written and tested against a **simulated adapter**, not
physical hardware. Try it parked, and compare against a tool you trust.

- Manufacturer-specific PID definitions (ATF/CVT temperature, pulley pressures,
  VVT angle, …) are **not bundled**. They vary by model/year/module and
  a wrong byte offset gives believable wrong numbers. The picker lists what
  exists on your platform and gives you a "Define…" button to enter one.
- Standard PIDs marked *unverified* may not be implemented by your car.
- Web Bluetooth only reaches Bluetooth LE adapters, needs HTTPS, and works in
  Chrome/Edge (desktop) and Chrome on Android — not Safari or Firefox.

## Running locally

```
python3 -m http.server 8000
```

Then open `http://localhost:8000` in Chrome (localhost counts as secure).

## Stack

Plain HTML, CSS, and JavaScript. Chart.js via CDN. No build step.
