'use strict';
/**
 * Text I/O that keeps a file's bytes style: UTF-8 (with/without BOM) or CP949/EUC-KR, and CRLF/LF.
 * Node has no EUC-KR encoder, so the reverse table is built once from TextDecoder('euc-kr').
 */
const fs = require('fs');

let cp949Map = null; // char -> Buffer
function cp949Table() {
  if (cp949Map) return cp949Map;
  cp949Map = new Map();
  const dec = new TextDecoder('euc-kr');
  const b = new Uint8Array(2);
  for (let hi = 0x81; hi <= 0xfe; hi++) {
    for (let lo = 0x41; lo <= 0xfe; lo++) {
      b[0] = hi; b[1] = lo;
      const ch = dec.decode(b);
      if (ch.length === 1 && ch !== '�' && !cp949Map.has(ch)) cp949Map.set(ch, Buffer.from([hi, lo]));
    }
  }
  return cp949Map;
}

function encodeCp949(text) {
  const t = cp949Table();
  const out = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) out.push(Buffer.from([c]));
    else {
      const bytes = t.get(ch);
      if (!bytes) throw new Error(`CP949 로 표현할 수 없는 문자: "${ch}" (U+${c.toString(16).toUpperCase()})`);
      out.push(bytes);
    }
  }
  return Buffer.concat(out);
}

/** @returns {{text:string, encoding:'utf8'|'utf8bom'|'cp949', eol:'\r\n'|'\n', binary:boolean}} */
function decodeFile(buf) {
  if (buf.subarray(0, 8000).includes(0)) return { text: '', encoding: 'utf8', eol: '\n', binary: true };
  let encoding = 'utf8';
  let text;
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    encoding = 'utf8bom';
    text = buf.subarray(3).toString('utf8');
  } else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch (_) {
      encoding = 'cp949';
      text = new TextDecoder('euc-kr').decode(buf);
    }
  }
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.match(/(^|[^\r])\n/g) || []).length;
  return { text, encoding, eol: crlf >= lf && crlf > 0 ? '\r\n' : '\n', binary: false };
}

function encodeText(text, encoding) {
  if (encoding === 'cp949') return encodeCp949(text);
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/** Model text uses "\n"; convert to the file's line ending. */
const toEol = (text, eol) => (eol === '\r\n' ? text.replace(/\r?\n/g, '\r\n') : text.replace(/\r\n/g, '\n'));

function readText(file) {
  return decodeFile(fs.readFileSync(file));
}

/** Write text keeping the existing file's encoding/EOL (new files: defaults). */
function writeText(file, text, { defaultEol = '\r\n', defaultEncoding = 'utf8' } = {}) {
  let style = { encoding: defaultEncoding, eol: defaultEol };
  if (fs.existsSync(file)) {
    const cur = readText(file);
    if (!cur.binary) style = { encoding: cur.encoding, eol: cur.eol };
  }
  fs.writeFileSync(file, encodeText(toEol(text, style.eol), style.encoding));
  return style;
}

module.exports = { decodeFile, encodeText, encodeCp949, readText, writeText, toEol };
