# Maintenance review — 2026-10-27

## Issues and pull requests

| Item | Assessment and action |
|---|---|
| [#26](https://github.com/IJustItay/Neon-Equalizer/issues/26), [#28](https://github.com/IJustItay/Neon-Equalizer/issues/28), [PR #27](https://github.com/IJustItay/Neon-Equalizer/pull/27) | Confirmed mismatch between Windows PowerShell output encoding and Node's UTF-8 decoder. Integrated the PR and extended its real PowerShell tests to code pages 936, 866 and 1251, including Cyrillic, Chinese, Korean and emoji names through APO serialization. |
| [#29](https://github.com/IJustItay/Neon-Equalizer/issues/29) | Confirmed global Ctrl+Alt registrations can intercept AltGr input. Global shortcuts now default to disabled, have a persistent tray checkbox, and use Ctrl+Shift when enabled. Tests cover opt-in/out, persistence failures, actions and tray labels. |
| [PR #12](https://github.com/IJustItay/Neon-Equalizer/pull/12) | Legitimate Vite upgrade. Integrated its branch and updated Vite and Vitest together to compatible patched versions. Renamed ESM config files to `.mjs`. Updated the Electron runtime and build dependencies after reviewing the dependency audit, and migrated image capture to the asynchronous ClipboardItem API with regression tests. |
| [PR #4](https://github.com/IJustItay/Neon-Equalizer/pull/4) | Stale npm lockfile patch with unrelated UI/website changes. The current pnpm dependency graph already supersedes its XML package fix. Do not merge the unrelated branch. |
| [PR #5](https://github.com/IJustItay/Neon-Equalizer/pull/5) | Stale npm lockfile patch. `ip-address` is absent from the current dependency graph; there is no affected installed package to update. |

Previously closed reports were reviewed against the existing fixes and regression tests. Native audio processing remains outside this maintenance change.

## Publication boundaries

- Runtime packaging names the two public Electron entry files explicitly rather than including every local Electron file.
- Git ignore rules exclude local credentials, private work, research reports and build output.
- Obsolete build scripts, a captured third-party HTML page, local skill metadata and old installer copies are removed from the tracked source tree. Existing local copies are preserved; downloads belong in GitHub Releases.
- Personal filesystem metadata was removed from a bundled target's comments; its measurement values are unchanged.
- CI checks public paths, common credential patterns and the packaging allowlist. It reports file names and categories without exposing matching values. This is a preventative check, not a guarantee against every possible secret format.
- Existing public history, forks and closed pull requests are not rewritten by these changes. Ignore rules protect future additions; they do not retract previously published material. No repository visibility change is made.

## CodeQL security review — 2026-10-28

Seven existing alerts were validated and addressed: graph legend labels/colors (alert 9), toast messages and exception text (6 and 7), copy expressions (3), delays (4), imported parametric filter values (2), and CI token permissions (8). Imported form values now use DOM properties, notification messages use `textContent`, legend text is escaped and colors validated, and CI declares `contents: read`. Regression tests cover hostile markup, ordinary numeric formatting and continued editing. Alerts are resolved through code changes rather than dismissed.

## Validation

Run these checks with Node.js 22.12 or newer and the pinned pnpm version:

```sh
corepack pnpm install --frozen-lockfile
node scripts/check-publication.mjs
node --check electron/main.js
node --check electron/preload.js
corepack pnpm test
corepack pnpm audit --audit-level=high
corepack pnpm run icons
corepack pnpm build
```

The Windows encoding tests use simulated endpoint registry data in a real PowerShell subprocess. They do not change registry settings or APO configuration. Shortcut tests stub registration and file persistence rather than reserving the tester's actual keyboard shortcuts. Windows audio hardware, Bluetooth/HID devices and all international keyboard layouts still need release testing on real devices.

Local results: 117 tests passed across ten files; dependency audit reported zero known vulnerabilities; renderer, icon generation and Windows directory packaging succeeded. An isolated Electron 45.1.0 startup loaded the production CSP without renderer errors. Inspection of the application archive found only the two intended Electron source files and no private account/cloud modules. A temporary Git-index canary confirmed that the publication check rejects private source paths. A credential-pattern scan of 257 text blobs reachable from fetched public branch references found no matches.

Migration references: [Vite](https://vite.dev/guide/migration), [Vitest](https://vitest.dev/guide/migration/), and [Electron breaking changes](https://www.electronjs.org/docs/latest/breaking-changes).
