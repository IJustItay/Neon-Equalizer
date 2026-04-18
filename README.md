<p align="center">
  <img src="docs/images/logo.png" width="132" alt="Neon Equalizer logo">
</p>

<h1 align="center">Neon Equalizer</h1>

<p align="center">
  A modern Windows desktop equalizer for Equalizer APO with parametric EQ, AutoEQ, Squiglink targets, live preview, presets, and device PEQ tools.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> |
  <a href="#downloads">Downloads</a> |
  <a href="#features">Features</a> |
  <a href="#build-from-source">Build from source</a> |
  <a href="docs/USAGE.md">Usage guide</a>
</p>

![Neon Equalizer app screenshot](docs/images/app-screenshot.png)

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

- [Portable app](downloads/Neon-Equalizer-2.0.0-Portable.exe) - run without installing.
- [Installer](downloads/Neon-Equalizer-2.0.0-Setup.exe) - guided installation with shortcuts.

Checksums are available in [SHA256SUMS.txt](downloads/SHA256SUMS.txt).

## Features

- Parametric EQ editor with draggable response graph.
- Graphic EQ mode for broad shaping.
- AutoEQ and headphone target workflows.
- Squiglink integration for headphone measurements and targets.
- EQ preview player with pink noise, white noise, and audio-file playback.
- Config import/export for Equalizer APO text files.
- Presets, undo/redo, clipping protection, target customization, and tray access.
- Neon app icon, favicon, and Windows `.ico` assets generated from one SVG source.

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

The portable output is written to `release/Neon-Equalizer-2.0.0-Portable.exe`.

## Repository Design

- `assets/icon.svg` is the editable logo source.
- `assets/icon.ico`, `assets/icon.png`, and `assets/icons/*` are generated app icon files.
- `docs/images/logo.png` and `docs/images/app-screenshot.png` are used by the GitHub README.
- `electron/` contains the desktop shell, tray integration, file dialogs, and Equalizer APO config access.
- `src/` contains the app UI and equalizer logic.
- `public/targets/` contains bundled target curves.

## License

This project is licensed under the repository license.
