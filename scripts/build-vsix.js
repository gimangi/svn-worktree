'use strict';
/**
 * Build dist/svn-worktree-<version>.vsix without npm/vsce (a VSIX is an OPC zip).
 *   scripts\build-vsix.cmd
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const INCLUDE = ['package.json', 'README.md', 'LICENSE', 'media', 'src'];

function walk(rel, out) {
  const abs = path.join(root, rel);
  if (!fs.existsSync(abs)) return;
  if (fs.statSync(abs).isDirectory()) for (const n of fs.readdirSync(abs)) walk(path.join(rel, n), out);
  else out.push(rel.split(path.sep).join('/'));
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${esc(pkg.name)}" Version="${esc(pkg.version)}" Publisher="${esc(pkg.publisher)}" />
    <DisplayName>${esc(pkg.displayName)}</DisplayName>
    <Description xml:space="preserve">${esc(pkg.description)}</Description>
    <Tags>${esc((pkg.keywords || []).join(','))}</Tags>
    <Categories>${esc((pkg.categories || []).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${esc(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
    </Properties>
    <License>extension/LICENSE</License>
    <Icon>extension/media/icon.png</Icon>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Icons.Default" Path="extension/media/icon.png" Addressable="true" />
  </Assets>
</PackageManifest>
`;

const MIME = {
  json: 'application/json', vsixmanifest: 'text/xml', js: 'application/javascript', md: 'text/markdown',
  png: 'image/png', svg: 'image/svg+xml', txt: 'text/plain', cmd: 'text/plain',
};

/**
 * [Content_Types].xml valid for strict OPC readers (System.IO.Packaging): one Default per extension
 * (OPC spelling without the dot) and an Override for files without an extension.
 */
function contentTypesFor(names) {
  const exts = new Set();
  const overrides = [];
  for (const n of names) {
    const base = n.split('/').pop();
    const dot = base.lastIndexOf('.');
    if (dot <= 0) overrides.push(n);
    else exts.add(base.slice(dot + 1).toLowerCase());
  }
  const lines = [];
  for (const e of [...exts].sort()) {
    const ct = MIME[e] || 'application/octet-stream';
    lines.push(`  <Default Extension="${e}" ContentType="${ct}" />`);
  }
  for (const n of overrides) lines.push(`  <Override PartName="/${esc(n)}" ContentType="text/plain" />`);
  return `<?xml version="1.0" encoding="utf-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n${lines.join('\n')}\n</Types>\n`;
}

const { zip } = require('./zip');

const files = [];
for (const i of INCLUDE) walk(i, files);
const partNames = ['extension.vsixmanifest', ...files.map((f) => 'extension/' + f)];
const entries = [
  { name: '[Content_Types].xml', data: Buffer.from(contentTypesFor(partNames)) },
  { name: 'extension.vsixmanifest', data: Buffer.from(manifest) },
  ...files.map((f) => ({ name: 'extension/' + f, data: fs.readFileSync(path.join(root, f)) })),
];
const outDir = path.join(root, 'dist');
fs.mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `${pkg.name}-${pkg.version}.vsix`);
fs.writeFileSync(out, zip(entries));
console.log(`${out}  (${files.length} files, ${fs.statSync(out).size} bytes)`);
