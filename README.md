<p align="center">
  <img src="docs/images/logo.png" width="120" alt="Neon Equalizer logo">
</p>

<h1 align="center">Neon Equalizer</h1>

<p align="center">
  A modern Windows GUI for <a href="https://sourceforge.net/projects/equalizerapo/">Equalizer APO</a> —<br>
  parametric EQ, AutoEQ from real headphone measurements, live preview, and hardware PEQ transfer.
</p>

<p align="center">
  <a href="https://github.com/IJustItay/Neon-Equalizer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/IJustItay/Neon-Equalizer?style=for-the-badge&label=release&color=00d4ff"></a>
  <a href="https://github.com/IJustItay/Neon-Equalizer/releases"><img alt="Downloads" src="https://img.shields.io/github/downloads/IJustItay/Neon-Equalizer/total?style=for-the-badge&color=7c3aed"></a>
  <a href="https://github.com/IJustItay/Neon-Equalizer/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/IJustItay/Neon-Equalizer/ci.yml?style=for-the-badge&label=CI"></a>
  <a href="LICENSE"><img alt="License: GPL-3.0" src="https://img.shields.io/github/license/IJustItay/Neon-Equalizer?style=for-the-badge&color=10b981"></a>
</p>

<p align="center">
  <a href="#download">Download</a> ·
  <a href="#quick-start">Quick start</a> ·
  <a href="#features">Features</a> ·
  <a href="#building-from-source">Build from source</a> ·
  <a href="docs/USAGE.md">Usage guide</a>
</p>

![Neon Equalizer — parametric EQ editor with frequency-response graph](docs/images/app-screenshot.png)

## Overview

Equalizer APO is the most powerful system-wide equalizer on Windows — but it is configured through text files. Neon Equalizer puts a full-featured, real-time interface on top of it:

- **Drag filters directly on the frequency-response graph** and hear the result live before saving.
- **AutoEQ built in**: pick your headphone from 25,000+ community measurements, pick a target curve, and generate a parametric correction in seconds — no external tools.
- **Round-trip safe**: your existing `config.txt` is parsed and re-written faithfully, including conditional (`If`/`EndIf`) blocks, per-channel filters, comments, and disabled includes.
- **Beyond software EQ**: push your parametric filters into hardware — USB DACs, dongles, and network streamers with built-in PEQ.

## Download

Get the latest build from the **[Releases page](https://github.com/IJustItay/Neon-Equalizer/releases/latest)**:

| Asset | Use it when |
|---|---|
| `Neon-Equalizer-x.y.z-Setup.exe` | You want a normal installation with shortcuts and **automatic in-app updates** |
| `Neon-Equalizer-x.y.z-Portable.exe` | You want a single file you can run from anywhere, no install |

Every release ships a `SHA256SUMS.txt` you can use to verify your download:

```powershell
Get-FileHash .\Neon-Equalizer-*-Setup.exe -Algorithm SHA256
```

> [!NOTE]
> Builds are currently unsigned, so Windows SmartScreen may show an "unknown publisher" warning on first run (**More info → Run anyway**). Verifying the SHA-256 checksum above confirms the file is the exact one published here.

## Quick Start

1. Install [Equalizer APO](https://sourceforge.net/projects/equalizerapo/) and enable it for your playback device (run its Configurator once).
2. Download and run Neon Equalizer. It asks for administrator permission because Equalizer APO stores its configuration under `Program Files`.
3. The app auto-detects your APO config folder (or lets you pick it manually).
4. Add filters — or open **AutoEQ & Headphones**, choose your headphone and a target, and click **Run AutoEQ**.
5. Preview the result with the built-in player, then hit **Save to APO** (or enable Auto Save).

The [usage guide](docs/USAGE.md) covers every panel in detail.

## Features

### Equalizer
- **Parametric EQ** — unlimited bands with peaking, shelf, high/low-pass, notch, band-pass, and all-pass filters; edit by dragging graph nodes or typing exact values.
- **Graphic EQ** — fixed-band sliders for broad tonal shaping.
- **Per-channel filters** — target left/right, center, LFE, and surround channels individually; channel assignments survive save/reload exactly.
- **Auto preamp & clipping protection** — gain is compensated automatically so boosts never clip.
- **Snapshots, undo/redo, and A/B slots** — experiment freely and compare two tunings with one click.

### AutoEQ & headphone targets
- **Squig.link browser built in** — search 25,000+ headphone and IEM measurements from 140+ reviewer databases, with signature and source filters.
- **Reviewer target curves** — each reviewer's own preferred targets load automatically, alongside 29 bundled industry targets (Harman, diffuse-field, JM-1, and more).
- **Target customizer** — tilt, bass, treble, and ear-gain adjustments applied before optimization.
- **Off-thread optimizer** — AutoEQ runs in a Web Worker with live progress; the UI never freezes, and rig mismatches (711 vs 5128 measurements) are detected before they produce a bad correction.
- **FR Tracer** — capture a frequency-response graph image and trace it into usable measurement data.

### Listening tools
- **Live EQ preview** — pink noise, white noise, or your own audio files, with the EQ toggleable in real time.
- **Surround setup** — per-channel gain and delay for speaker configurations, with HRTF support.
- **Device switching** — apply profiles per playback device, with optional automatic switching.

### Hardware PEQ transfer
Push filters straight into devices with onboard parametric EQ:
- **USB (HID / Serial)** — supported DACs and dongles, including the JDS Labs Element IV / Atom 2 protocol.
- **Bluetooth LE** — supported true-wireless earbuds.
- **Network (LAN)** — WiiM / Linkplay streamers and Luxsin devices over your local network.

### Power-user features
- **Faithful config round-trips** — conditional `If`/`EndIf` blocks, `Eval` lines, comments, disabled `# Include:` directives, and unknown commands are preserved byte-for-byte on save.
- **VST plugin & Loudness Correction entries**, convolution, delays, and channel routing (Copy) — managed from the Advanced panel.
- **Raw config editor** — full text editing with parse-back into the visual UI.
- **Presets & user-data backup** — export/import EQ presets; back up presets, device profiles, snapshots, and settings to a single `.zip`.
- **Auto-updates** — installed builds check GitHub Releases and update in place (portable builds notify only).

## Building From Source

**Requirements:** Windows 10+, [Node.js](https://nodejs.org/) 22.12 or newer, and Equalizer APO for real audio output.

The project uses **pnpm** via Corepack — no global install needed:

```powershell
corepack enable          # once (run terminal as Administrator the first time)
pnpm install             # install dependencies
```

| Command | What it does |
|---|---|
| `pnpm dev` | Vite dev server + Electron with hot reload |
| `pnpm test` | Run the Vitest suite |
| `pnpm build` | Build the renderer bundle to `dist/` |
| `pnpm run icons` | Regenerate icon assets from `assets/icon.svg` |
| `pnpm dist` | Build `Setup.exe` + `Portable.exe` into `release/` |

To test **production-only behavior** (the packaged Content-Security-Policy, `file://` loading) without a full package step:

```powershell
$env:NEON_EQ_LOAD_DIST = '1'; pnpm exec electron .
```

When publishing a release, upload `latest.yml` and the `.blockmap` alongside the installer — the in-app updater depends on both.

## Project Structure

```
electron/         Main process — window, tray, IPC, APO detection, auto-updater
src/
  main.js         Renderer entry — UI logic
  components/     Graph, EQ editors, AutoEQ engine, Squig browser, device PEQ
  config/         Equalizer APO config.txt parser + serializer
  dsp/            Shared biquad math (graph + optimizer use identical curves)
  workers/        Off-thread AutoEQ worker
public/targets/   Bundled target curves
assets/icon.svg   Logo source (all icons are generated from this)
```

## Security

The renderer runs sandboxed with a strict production Content-Security-Policy (no eval, no remote scripts). All privileged operations go through validated IPC channels: file access is scoped to the APO config directory and user-selected paths, and network fetches are SSRF-guarded (DNS validated at connect time, redirects re-checked per hop). Remote data — measurements, reviewer configs — is parsed as pure data and never executed.

Found a security issue? Please open an issue or contact the maintainer privately.

## Contributing

Bug reports and pull requests are welcome. Before submitting a PR, please run `pnpm test` and `pnpm build`, and keep the app dependency-light — the UI is deliberately vanilla JavaScript (no frameworks).

## License

[GPL-3.0](LICENSE) — free to use, study, share, and improve.
