'use strict';
/**
 * Release bundle for bringing into an internal network:
 *   dist/svnwt-<ver>-release.zip
 *     svnwt-<ver>/svn-worktree-<ver>.vsix, INSTALL.md, CHANGELOG.md, README.md,
 *                 svnwt-<ver>-source.zip, test-report/, SHA256SUMS.txt
 *   scripts\build-release.cmd
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { zip } = require('./zip');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const ver = pkg.version;
const name = `svnwt-${ver}`;

// 1) fresh VSIX
const r = spawnSync(process.execPath, [path.join(__dirname, 'build-vsix.js')], { env: process.env, encoding: 'utf8' });
if (r.status !== 0) throw new Error(r.stderr || r.stdout);
const vsix = path.join(root, 'dist', `${pkg.name}-${ver}.vsix`);

function walk(rel, out, skip = () => false) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs) || skip(rel)) return;
  if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs)) walk(path.join(rel, n), out, skip);
  else out.push(rel.split(path.sep).join('/'));
}

// 2) source archive (everything needed to review / rebuild; no build step, no dependencies)
const srcFiles = [];
for (const i of ['package.json', 'README.md', 'INSTALL.md', 'CHANGELOG.md', 'LICENSE', 'media', 'src', 'scripts', 'test']) walk(i, srcFiles);
const sourceZip = zip(srcFiles.map((f) => ({ name: `${name}-source/${f}`, data: fs.readFileSync(path.join(root, f)) })));

// 3) bundle
const files = [
  { name: `${pkg.name}-${ver}.vsix`, data: fs.readFileSync(vsix) },
  { name: 'INSTALL.md', data: fs.readFileSync(path.join(root, 'INSTALL.md')) },
  { name: 'CHANGELOG.md', data: fs.readFileSync(path.join(root, 'CHANGELOG.md')) },
  { name: 'README.md', data: fs.readFileSync(path.join(root, 'README.md')) },
  { name: `${name}-source.zip`, data: sourceZip },
];
const report = [];
walk('docs/ui-test', report);
for (const f of report) files.push({ name: 'test-report/' + f.replace(/^docs\/ui-test\//, ''), data: fs.readFileSync(path.join(root, f)) });
const sums = files.map((f) => `${crypto.createHash('sha256').update(f.data).digest('hex')}  ${f.name}`).join('\n') + '\n';
files.push({ name: 'SHA256SUMS.txt', data: Buffer.from(sums) });

const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${name}-release.zip`);
fs.writeFileSync(out, zip(files.map((f) => ({ name: `${name}/${f.name}`, data: f.data }))));
const zipSha = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex');
fs.writeFileSync(out + '.sha256', `${zipSha}  ${path.basename(out)}\n`);
console.log(`${out}\n  ${files.length} files, ${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB\n  sha256 ${zipSha}`);
console.log(sums);
