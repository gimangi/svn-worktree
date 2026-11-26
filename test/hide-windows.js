'use strict';
/**
 * Tests run under Code.exe (ELECTRON_RUN_AS_NODE), a GUI program without a console: every console child
 * (svn.exe, git.exe, powershell.exe, cmd.exe) would open its own window and take the focus.
 * Require this first in a test entry file: child_process calls get windowsHide: true by default.
 */
const cp = require('child_process');

const hide = (opts) => Object.assign({ windowsHide: true }, opts || {});
// (file, args?, options?, callback?) — find where the options object is
function patch(name, optIndexOf) {
  const orig = cp[name];
  if (!orig || orig.__svnwtHidden) return;
  const wrapped = function (...a) {
    const i = optIndexOf(a);
    if (i >= 0) a[i] = hide(a[i]);
    return orig.apply(this, a);
  };
  wrapped.__svnwtHidden = true;
  cp[name] = wrapped;
}
const isOpts = (x) => x === undefined || x === null || (typeof x === 'object' && !Array.isArray(x));
// spawn / spawnSync / execFile / execFileSync / fork: (file, [args], [options], [cb])
const fileStyle = (a) => {
  if (Array.isArray(a[1])) { if (typeof a[2] === 'function') { a.splice(2, 0, {}); } if (a.length < 3) a.length = 3; return 2; }
  if (typeof a[1] === 'function') { a.splice(1, 0, [], {}); return 2; }
  if (a.length < 2) a.length = 2;
  return isOpts(a[1]) ? 1 : -1;
};
// exec / execSync: (command, [options], [cb])
const cmdStyle = (a) => {
  if (typeof a[1] === 'function') { a.splice(1, 0, {}); return 1; }
  if (a.length < 2) a.length = 2;
  return isOpts(a[1]) ? 1 : -1;
};
for (const n of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'fork']) patch(n, fileStyle);
for (const n of ['exec', 'execSync']) patch(n, cmdStyle);

module.exports = { hide };
