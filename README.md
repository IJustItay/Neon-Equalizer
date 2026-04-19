<p align="center">
  <img src="docs/images/logo.png" width="132" alt="Neon Equalizer logo">
</p>

<h1 align="center">Neon Equalizer</h1>

<p align="center">
  A modern Windows Equalizer APO GUI for parametric EQ, AutoEQ, Squiglink headphone targets, live audio preview, presets, and device PEQ workflows.
</p>

<p align="center">
  <a href="https://github.com/IJustItay/Neon-Equalizer/releases/latest"><img alt="Latest release" src="https://img.shields.io/github/v/release/IJustItay/Neon-Equalizer?style=for-the-badge&label=release&color=00d4ff"></a>
  <a href="https://github.com/IJustItay/Neon-Equalizer/releases"><img alt="GitHub downloads" src="https://img.shields.io/github/downloads/IJustItay/Neon-Equalizer/total?style=for-the-badge&color=7c3aed"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/github/license/IJustItay/Neon-Equalizer?style=for-the-badge&color=10b981"></a>
  <img alt="Windows 10+" src="https://img.shields.io/badge/Windows-10%2B-00a8ff?style=for-the-badge&logo=windows">
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> |
  <a href="#downloads">Downloads</a> |
  <a href="#features">Features</a> |
  <a href="#build-from-source">Build from source</a> |
  <a href="docs/USAGE.md">Usage guide</a>
</p>

![Neon Equalizer app screenshot](docs/images/app-screenshot.png)

## What Is Neon Equalizer?

Neon Equalizer is a desktop audio tuning app for Windows. It gives Equalizer APO users a cleaner interface for headphone EQ, speaker correction, parametric filters, VST plugin chains, loudness correction, AutoEQ-style workflows, Squiglink measurements, and quick A/B previewing before saving changes to APO.

Useful for headphone EQ, IEM tuning, speaker correction, gaming audio profiles, music presets, and anyone who wants a modern GUI for Equalizer APO config files.

## Quick Start

Neon Equalizer is designed for Windows users who already use, or want to use, [Equalizer APO](https://sourceforge.net/projects/equalizerapo/).

1. Install Equalizer APO and configure it for your playback device.
2. Download or build the Neon Equalizer portable app.
3. Run `Neon Equalizer.exe`.
4. Let the app detect your Equalizer APO config folder, or choose it manually.
5. Add filters, load an AutoEQ target, preview the result, then click **Save to APO**.

The packaged Windows build requests administrator permission because Equalizer APO normally stores its config under `Program Files`.

## Downloads

Choose one Windows build:

- [Portable app](https://github.com/IJustItay/Neon-Equalizer/releases/latest/download/Neon-Equalizer-2.0.7-Portable.exe) - run without installing.
- [Installer](https://github.com/IJustItay/Neon-Equalizer/releases/latest/download/Neon-Equalizer-2.0.7-Setup.exe) - guided installation with shortcuts.

Checksums are available in [SHA256SUMS.txt](https://github.com/IJustItay/Neon-Equalizer/releases/latest/download/SHA256SUMS.txt).

## Features

- Parametric EQ editor with draggable response graph.
- Graphic EQ mode for broad shaping.
- AutoEQ and headphone target workflows.
- Squiglink integration for headphone measurements and targets.
- EQ preview player with pink noise, white noise, and audio-file playback.
- Config import/export for Equalizer APO text files.
- VST plugin entries for Equalizer APO `.dll` effects.
- Loudness Correction controls for APO reference level, offset, and attenuation.
- Presets, undo/redo, clipping protection, target customization, and tray access.
- Neon app icon, favicon, and Windows `.ico` assets generated from one SVG source.

## Keywords

`equalizer apo`, `windows equalizer`, `parametric eq`, `headphone eq`, `vst plugins`, `loudness correction`, `autoeq`, `squiglink`, `audio dsp`, `electron app`, `portable windows app`, `iem tuning`, `speaker correction`, `eq presets`

## Build From Source

Requirements:

- Windows 10 or newer
- Node.js 20 or newer
- Equalizer APO for real system-wide EQ output

Install dependencies:

```powershell
npm install
```

Run the web UI and Electron app in development:

```powershell
npm run dev
```

Generate icon assets:

```powershell
npm run icons
```

Build the web bundle:

```powershell
npm run build
```

Create the portable Windows executable:

```powershell
npm run dist
```

The outputs are written to `release/Neon-Equalizer-2.0.7-Portable.exe` and `release/Neon-Equalizer-2.0.7-Setup.exe`.

## Repository Design

- `assets/icon.svg` is the editable logo source.
- `assets/icon.ico`, `assets/icon.png`, and `assets/icons/*` are generated app icon files.
- `docs/images/logo.png` and `docs/images/app-screenshot.png` are used by the GitHub README.
- `electron/` contains the desktop shell, tray integration, file dialogs, and Equalizer APO config access.
- `src/` contains the app UI and equalizer logic.
- `public/targets/` contains bundled target curves.

## License

This project is licensed under the repository license.
