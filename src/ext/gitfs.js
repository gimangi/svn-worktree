'use strict';
const vscode = require('vscode');

const SCHEME = 'svnwt-git';

/**
 * Read-only file system exposing git blobs: svnwt-git:/<scopeId>/<rev>/<rel path>
 * rev "empty" => empty file (added/deleted side of a diff).
 * Using a FileSystemProvider (bytes) lets VS Code apply its own encoding detection (CP949/UTF-8).
 */
class GitFs {
  constructor(service) {
    this.service = service;
    this._emitter = new vscode.EventEmitter();
    this.onDidChangeFile = this._emitter.event;
    this.cache = new Map();
  }

  static uri(scopeId, rev, rel) {
    return vscode.Uri.from({ scheme: SCHEME, path: `/${scopeId}/${rev}/${rel}` });
  }

  _parse(uri) {
    const parts = uri.path.replace(/^\//, '').split('/');
    return { scopeId: parts[0], rev: parts[1], rel: parts.slice(2).join('/') };
  }

  async _read(uri) {
    const k = uri.toString();
    if (this.cache.has(k)) return this.cache.get(k);
    const { scopeId, rev, rel } = this._parse(uri);
    let data = new Uint8Array(0);
    if (rev !== 'empty') {
      const scope = this.service.resolveScope(scopeId);
      const git = await this.service.git(scope);
      const b = await git.blob(rev, rel);
      if (b) data = new Uint8Array(b);
    }
    if (this.cache.size > 200) this.cache.clear();
    this.cache.set(k, data);
    return data;
  }

  watch() { return new vscode.Disposable(() => {}); }

  async stat(uri) {
    const d = await this._read(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: 0, size: d.length, permissions: vscode.FilePermission.Readonly };
  }

  readDirectory() { return []; }
  readFile(uri) { return this._read(uri); }
  createDirectory() { throw vscode.FileSystemError.NoPermissions(); }
  writeFile() { throw vscode.FileSystemError.NoPermissions(); }
  delete() { throw vscode.FileSystemError.NoPermissions(); }
  rename() { throw vscode.FileSystemError.NoPermissions(); }
}

module.exports = { GitFs, SCHEME };
