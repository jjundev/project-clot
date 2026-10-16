import fs from "node:fs";
import path from "node:path";
export const assetSource = (payload) =>
  "globalThis.__CLOT_ASSETS__=globalThis.__CLOT_ASSETS__||{};globalThis.__CLOT_ASSETS__[" +
  JSON.stringify(payload.id) +
  "]=" +
  JSON.stringify(payload).replace(/</g, "\\u003c") +
  ";\n";
export function createAssetWriter({ outDir, revision, maxBytes = 262144 }) {
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  let serial = 0;
  function writeRecord(kind, record) {
    if (!/^[a-z-]+$/.test(kind)) throw Error("Invalid asset kind");
    const id = kind + "-" + String(serial++).padStart(6, "0"),
      payload = { v: 2, revision, id, ...record },
      s = assetSource(payload),
      bytes = Buffer.byteLength(s);
    if (bytes > maxBytes)
      throw Error("Dashboard asset exceeds byte limit: " + id);
    const file = "assets/" + id + ".js";
    fs.writeFileSync(path.join(outDir, file), s);
    return {
      id,
      path: file,
      bytes,
      count: record.rows?.length ?? record.items?.length ?? 1,
    };
  }
  function writeRows(kind, rows) {
    const refs = [];
    let buffer = [],
      size = 300;
    for (const row of rows) {
      const bytes = Buffer.byteLength(JSON.stringify(row)) + 1;
      if (buffer.length && size + bytes > maxBytes - 128) {
        refs.push(writeRecord(kind, { rows: buffer }));
        buffer = [];
        size = 300;
      }
      buffer.push(row);
      size += bytes;
    }
    if (buffer.length) refs.push(writeRecord(kind, { rows: buffer }));
    return refs;
  }
  return { writeRecord, writeRows, maxBytes, revision };
}
