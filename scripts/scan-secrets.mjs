#!/usr/bin/env node
// Fails if anything that looks like a real secret is in the tracked files or anywhere in git
// history. Runs in CI and before pushes. Zero dependencies.
import { execFileSync } from 'node:child_process';

const PATTERNS = [
  ['private key block', /-----BEGIN (?:EC |RSA |ENCRYPTED )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}/],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{20,}/],
  ['Last.fm key/secret assignment', /LASTFM_API_(?:KEY|SECRET)\s*[=:]\s*["']?[0-9a-f]{32}\b/i],
  ['ENCRYPTION_KEY assignment', /ENCRYPTION_KEY\s*[=:]\s*["']?[A-Za-z0-9+/]{43}=/],
  ['Cloudflare API token', /\bCLOUDFLARE_API_TOKEN\s*[=:]\s*["']?[A-Za-z0-9_-]{40}\b/],
  ['GitHub token', /\bgh[pousr]_[A-Za-z0-9]{36,}\b/],
  ['AWS key', /\bAKIA[0-9A-Z]{16}\b/],
];
const FORBIDDEN_FILES = [/\.p8$/, /(^|\/)\.dev\.vars$/, /(^|\/)\.env$/, /spike\/\.secrets\.json$/];

const git = (...a) => execFileSync('git', a, { encoding: 'utf8', maxBuffer: 1 << 28 });
const problems = [];

for (const f of git('ls-files').split('\n').filter(Boolean)) {
  if (FORBIDDEN_FILES.some((r) => r.test(f)))
    problems.push(`tracked file that must never be committed: ${f}`);
}
for (const f of git('log', '--all', '--name-only', '--format=').split('\n').filter(Boolean)) {
  if (FORBIDDEN_FILES.some((r) => r.test(f)))
    problems.push(`file in git history that must never be committed: ${f}`);
}
const history = git('log', '--all', '-p', '--format=commit %H');
let commit = '';
for (const line of history.split('\n')) {
  if (line.startsWith('commit ')) commit = line.slice(7, 15);
  if (!line.startsWith('+') && !line.startsWith('commit')) continue;
  for (const [name, re] of PATTERNS)
    if (re.test(line)) problems.push(`${name} in commit ${commit}: ${line.slice(0, 80)}…`);
}

if (problems.length) {
  console.error('Possible secrets found:\n' + [...new Set(problems)].map((p) => `  - ${p}`).join('\n'));
  process.exit(1);
}
console.log('No secrets found in tracked files or history.');
