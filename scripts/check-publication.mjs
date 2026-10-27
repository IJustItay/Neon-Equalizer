import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Check the public Git file list, not ignored developer files. Never print a
// matching value: even a failed CI run must not disclose a credential in logs.
const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
const privatePaths = [
  /(^|\/)(?:\.private|scratch|\.agents|\.claude|website|release|node_modules)\//,
  /(^|\/)(?:\.env(?:\..*)?|google-oauth[^/]*\.json|account\.dat)$/i,
  /(?:service[-_]?account|credentials)[^/]*\.json$/i,
  /\.(?:pem|key|p12|pfx)$/i,
  /^(?:firebase\.json|firestore\.[^/]+|vercel\.json)$/,
  /^(?:electron\/(?:googleAuth|cloudSync)\.js|src\/(?:firebaseConfig\.js|services\/cloudService\.js|components\/account\.js|state\/cloudSync\.js)|tests\/cloudSync\.test\.js|docs\/firebase-cloud-setup\.md)$/,
  /^(?:CODEBASE_AUDIT\.md|NATIVE_AUDIO_FEASIBILITY\.md|build-installer\.js|wiki\.html|skills-lock\.json)$/,
  /^downloads\//,
];
const secrets = [
  ['private key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['access credential', /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,}|AIza[0-9A-Za-z_-]{35}|AKIA[0-9A-Z]{16})\b/],
  ['stored account credential', /"(?:client_secret|clientSecret|private_key|refresh_token|access_token)"\s*:\s*"[^"\s][^"]*"/],
  ['personal Windows path', /[A-Z]:\\Users\\[^\\\s"'`]+/i],
];
const failures = [];
for (const file of files) {
  if (privatePaths.some(pattern => pattern.test(file))) {
    failures.push(`${file}: private or local-only path`);
    continue;
  }
  const data = readFileSync(file);
  if (data.includes(0)) continue; // Binary assets are checked by path, not text.
  const text = data.toString('utf8');
  for (const [label, pattern] of secrets) {
    if (pattern.test(text)) failures.push(`${file}: possible ${label}`);
  }
}

// Ignore rules do not constrain electron-builder. Keep runtime source explicit
// so a local module or credential cannot be packaged by a recursive glob.
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const allowedBuildPaths = new Set(['dist/**/*', 'electron/main.js', 'electron/preload.js', 'assets/**/*', 'package.json']);
if (!Array.isArray(pkg.build?.files) || pkg.build.files.some(file => !allowedBuildPaths.has(file))) {
  failures.push('package.json: build.files must use the reviewed public runtime allowlist');
}
if (pkg.build?.extraFiles || pkg.build?.extraResources) {
  failures.push('package.json: review extra packaged resources before publishing');
}
if (failures.length) {
  console.error(`Publication check failed:\n${failures.join('\n')}`);
  process.exitCode = 1;
} else {
  console.log(`Publication check passed (${files.length} tracked files; explicit runtime package allowlist).`);
}
