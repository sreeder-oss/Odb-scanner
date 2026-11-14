# Odb-scanner

A single-page OBD-II diagnostic dashboard for the OBDLink MX+, with enhanced
parameter profiles for Toyota, Nissan, and generic OBD-II vehicles.

**Live page:** https://sreeder-oss.github.io/Odb-scanner/

## What it does

- Real-time telemetry cards: engine RPM, calculated load, transmission/CVT
  fluid temp, and a make-specific secondary metric (Toyota VVT advance,
  Nissan CVT secondary pressure, generic fuel rail pressure)
- Two live Chart.js graphs (engine RPM/load, transmission temp)
- Simulation mode that generates plausible driving curves so the UI can be
  tested with no vehicle present
- CSV export of the recorded telemetry log
- "Copy AI Prompt" button that builds a diagnostic summary for pasting into
  a chat assistant

## Current state — read this before using it in a vehicle

The UI is complete. The **vehicle connection is not.** Specifically:

1. `toggleBluetooth()` pairs with the adapter over Web Bluetooth and flips the
   status light green, but `initOBDLink()` is a stub. It logs the AT command
   sequence (`AT Z`, `AT E0`, `AT SP 0`) without ever writing it to the device.
2. `rxCharacteristic` and `txCharacteristic` are declared but never assigned —
   there is no GATT service/characteristic discovery, so there is no channel
   to send or receive on.
3. There is no PID polling loop. Nothing reads mode 01 PIDs, so a successful
   pairing produces zero live data.
4. `scanDTCs()` renders a hardcoded `P0700` from the `activeDTCs` array. It
   does not issue mode 03. **Any code it displays is fake.**

So today this is a working dashboard driven by simulated data. Connecting to a
real MX+ gets you a green dot and nothing else.

### Also worth knowing

Web Bluetooth only talks to Bluetooth Low Energy, it requires HTTPS (GitHub
Pages provides that), and it is unsupported in Safari and Firefox. Use Chrome
or Edge on desktop, or Chrome on Android. The OBDLink MX+ exposes both
Bluetooth Classic SPP and BLE — the BLE side is the one this page would need.

## To finish the connection layer

In rough order:

1. After `device.gatt.connect()`, call `getPrimaryService()` and
   `getCharacteristic()` to resolve the real UUIDs, and assign them to
   `rxCharacteristic` / `txCharacteristic`.
2. Subscribe to notifications on the RX characteristic and buffer incoming
   bytes until the ELM327 `>` prompt arrives — responses are chunked.
3. Write the AT init sequence through TX and wait for each reply before
   sending the next.
4. Add a polling interval that requests PIDs (`010C` RPM, `0104` load, etc.),
   parses the hex response, and feeds the same UI update path the simulation
   already uses.
5. Replace `scanDTCs()` with a real mode 03 request and decode the response
   bytes into DTC strings.

## Running locally

Clone and open `index.html` in Chrome. Web Bluetooth needs a secure context,
so pairing will not work from `file://` — serve it instead:

```
python3 -m http.server 8000
```

Then visit `http://localhost:8000` (localhost counts as secure).

## Stack

Plain HTML, CSS, and JavaScript. Chart.js via CDN. No build step.
