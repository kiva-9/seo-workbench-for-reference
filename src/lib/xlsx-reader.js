// xlsx-reader.js —— 极简 .xlsx 读取器
//
// 只做文章导入需要的一件事：取一个工作表（按名字，默认第一个）的单元格字符串网格。
// 不追求通用 XLSX 库。安全边界：只解压有限几个命名部件，声明的与实际解压
// 大小都设上限——精心构造的压缩包不能逼出无界内存。

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_DIR_SIGNATURE = 0x02014b50;
const LOCAL_FILE_SIGNATURE = 0x04034b50;

const MAX_ENTRIES = 2000;
const STRUCTURE_MAX_BYTES = 1024 * 1024;   // workbook.xml / rels / sharedStrings
const SHEET_MAX_BYTES = 16 * 1024 * 1024;  // 单个工作表 XML

function corrupt(detail) {
  throw new Error(`文件已损坏或不是有效的 XLSX 文件${detail ? `（${detail}）` : ''}`);
}

function looksEncrypted(bytes) {
  // OLE/CFBF 签名：旧版 .xls 或加密/密码保护的 .xlsx 外壳
  const signature = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return signature.every((byte, index) => bytes[index] === byte);
}

function findEndOfCentralDirectory(bytes) {
  const minLength = 22;
  if (bytes.length < minLength) corrupt('文件过短');
  const searchStart = Math.max(0, bytes.length - minLength - 65535);
  for (let offset = bytes.length - minLength; offset >= searchStart; offset -= 1) {
    if (bytes[offset] === 0x50 && bytes[offset + 1] === 0x4b
      && bytes[offset + 2] === 0x05 && bytes[offset + 3] === 0x06) {
      const view = new DataView(bytes.buffer, bytes.byteOffset + offset, minLength);
      if (view.getUint32(0, true) !== EOCD_SIGNATURE) continue;
      return { entryCount: view.getUint16(10, true), centralDirOffset: view.getUint32(16, true) };
    }
  }
  corrupt('找不到 ZIP 目录结尾标记');
}

// 中央目录 → [{ name, compressionMethod, compressedSize, uncompressedSize, localOffset }]
function readCentralDirectory(bytes) {
  const eocd = findEndOfCentralDirectory(bytes);
  if (eocd.entryCount > MAX_ENTRIES) corrupt('压缩包内文件数量超出限制');
  const entries = [];
  let offset = eocd.centralDirOffset;
  for (let index = 0; index < eocd.entryCount; index += 1) {
    if (offset + 46 > bytes.length) corrupt('目录条目越界');
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 46);
    if (view.getUint32(0, true) !== CENTRAL_DIR_SIGNATURE) corrupt('目录条目签名无效');
    entries.push({
      name: readZipName(bytes, offset + 46, view.getUint16(28, true)),
      compressionMethod: view.getUint16(10, true),
      compressedSize: view.getUint32(20, true),
      uncompressedSize: view.getUint32(24, true),
      localOffset: view.getUint32(42, true),
    });
    offset += 46 + view.getUint16(28, true) + view.getUint16(30, true) + view.getUint16(32, true);
  }
  return entries;
}

function readZipName(bytes, offset, length) {
  return new TextDecoder('utf-8').decode(bytes.subarray(offset, offset + length));
}

// 按名字取一个条目并解压（store / deflate）。声明大小越界或实际解压超限都算损坏。
function readEntry(bytes, entry, declaredName) {
  if (entry.localOffset + 30 > bytes.length) corrupt(`${declaredName} 条目越界`);
  const view = new DataView(bytes.buffer, bytes.byteOffset + entry.localOffset, 30);
  if (view.getUint32(0, true) !== LOCAL_FILE_SIGNATURE) corrupt(`${declaredName} 本地头签名无效`);
  const nameLength = view.getUint16(26, true);
  const extraLength = view.getUint16(28, true);
  const dataStart = entry.localOffset + 30 + nameLength + extraLength;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > bytes.length) corrupt(`${declaredName} 数据越界`);
  const raw = bytes.subarray(dataStart, dataEnd);
  if (!entry.compressionMethod) return Buffer.from(raw);
  const out = require('node:zlib').inflateRawSync(raw);
  return Buffer.from(out);
}

function entryByName(entries, name) {
  return entries.find((e) => e.name === name) || null;
}

// 工作表名 → 目标 XML 路径（走 workbook.xml + rels）
function resolveSheetPath(bytes, entries, wantedName) {
  const workbookEntry = entryByName(entries, 'xl/workbook.xml');
  const relsEntry = entryByName(entries, 'xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) corrupt('缺少 workbook.xml');
  const workbook = readEntry(bytes, workbookEntry, 'workbook.xml').toString('utf8');
  if (workbook.length > STRUCTURE_MAX_BYTES) corrupt('workbook.xml 过大');
  const rels = readEntry(bytes, relsEntry, 'workbook.xml.rels').toString('utf8');
  if (rels.length > STRUCTURE_MAX_BYTES) corrupt('workbook.xml.rels 过大');

  const relTarget = new Map();
  for (const m of rels.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTarget.set(m[1], m[2].replace(/^\/?xl\//, '').replace(/^\//, ''));
  }
  const sheets = [];
  for (const m of workbook.matchAll(/<sheet\b([^>]*)\/>/g)) {
    const attrs = m[1];
    const name = (/name="([^"]*)"/.exec(attrs)?.[1] || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
    const rid = (/r:id="([^"]*)"/.exec(attrs) || /id="([^"]*)"/.exec(attrs))?.[1] || '';
    sheets.push({ name, target: relTarget.get(rid) || '' });
  }
  if (!sheets.length) corrupt('workbook.xml 里没有工作表');
  const picked = wantedName
    ? sheets.find((s) => s.name === wantedName) || null
    : sheets[0];
  if (!picked || !picked.target) corrupt(`找不到工作表${wantedName ? `「${wantedName}」` : ''}`);
  return `xl/${picked.target.replace(/^xl\//, '')}`;
}

// 共享字符串表（t="s" 的单元格按索引取）
function readSharedStrings(bytes, entries) {
  const entry = entryByName(entries, 'xl/sharedStrings.xml');
  if (!entry) return [];
  const xml = readEntry(bytes, entry, 'sharedStrings.xml').toString('utf8');
  if (xml.length > STRUCTURE_MAX_BYTES) return []; // 过大就当没有（导入只认表头行）
  const out = [];
  for (const m of xml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>|<si\b[^>]*\/>/g)) {
    const inner = m[1] || '';
    // 富文本：<si><r><t>a</t></r><r><t>b</t></r></si> 要拼接
    const parts = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    out.push(decodeXml(parts.join('')));
  }
  return out;
}

function decodeXml(text) {
  return String(text || '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, '&');
}

// 列字母 → 序号（A=0, B=1 … AA=26）
function colIndex(ref) {
  const letters = /^([A-Z]+)/.exec(ref || '');
  if (!letters) return null;
  let n = 0;
  for (const ch of letters[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function cellText(cellXml, shared) {
  const type = /(?:^|\s)t="([^"]+)"/.exec(cellXml)?.[1] || 'n';
  const ref = /(?:^|\s)r="([^"]+)"/.exec(cellXml)?.[1] || '';
  const inline = /<is\b[^>]*>([\s\S]*?)<\/is>/.exec(cellXml);
  if (type === 'inlineStr' || inline) {
    const parts = [...(inline ? inline[1] : cellXml).matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]);
    return { col: colIndex(ref), text: decodeXml(parts.join('')) };
  }
  const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(cellXml);
  const raw = v ? v[1] : '';
  if (type === 's') {
    const idx = Number(raw);
    const text = Number.isInteger(idx) ? (shared[idx] ?? '') : '';
    return { col: colIndex(ref), text };
  }
  if (type === 'b') return { col: colIndex(ref), text: raw === '1' ? 'TRUE' : 'FALSE' };
  return { col: colIndex(ref), text: decodeXml(raw) };
}

/**
 * 读一个工作表的单元格网格。
 * @param {Buffer|Uint8Array} bytes .xlsx 文件字节
 * @param {{ sheetName?: string }} [opts] sheetName 指定工作表；默认第一个
 * @returns {string[][]} 行 → 单元格字符串（缺列为空串；不裁剪全空行，由调用方决定）
 */
function readXlsxRows(bytes, opts = {}) {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (looksEncrypted(buf)) throw new Error('加密/旧版 .xls 文件不支持，请另存为 .xlsx 或 .csv');
  const entries = readCentralDirectory(buf);
  const sheetPath = resolveSheetPath(buf, entries, opts.sheetName || null);
  const entry = entryByName(entries, sheetPath);
  if (!entry) corrupt(`找不到工作表数据 ${sheetPath}`);
  if (entry.uncompressedSize > SHEET_MAX_BYTES) corrupt('工作表过大');
  const shared = readSharedStrings(buf, entries);
  const xml = readEntry(buf, entry, sheetPath).toString('utf8');
  if (xml.length > SHEET_MAX_BYTES) corrupt('工作表过大');

  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells = [];
    for (const cellMatch of rowMatch[1].matchAll(/<c\b[^>]*>([\s\S]*?)<\/c>|<c\b[^>]*\/>/g)) {
      const whole = cellMatch[0];
      const { col, text } = cellText(whole, shared);
      if (col === null || col === undefined) continue;
      while (cells.length < col) cells.push('');
      cells[col] = text;
    }
    rows.push(cells);
  }
  return rows;
}

module.exports = { readXlsxRows };
