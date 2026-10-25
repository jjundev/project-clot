import { isDeepStrictEqual } from "node:util";
import { createDashboardScope } from "../src/dashboard-scope.js";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { pathToFileURL } from "node:url";
import { createDashboardModel } from "../src/dashboard-model.js";
import { unpackIndex } from "../src/dashboard-index.js";
import { expandScanHistory } from "../src/dashboard-catalog.js";
export function verifyDashboardBuild(outputPath) {
  const html = fs.readFileSync(outputPath, "utf8"),
    match = html.match(/window\.__CLOT_DATA__ = ([\s\S]*?);\r?\n/);
  if (!match) throw Error("missing inline data");
  const D = JSON.parse(match[1]),
    manifest = D.catalog,
    model = createDashboardModel();
  if (manifest?.v === 2) return verifyV2(D, path.dirname(outputPath));
  if (
    manifest?.v !== 1 ||
    !manifest.revision ||
    !["complete", "partial", "unavailable"].includes(manifest.scanState)
  )
    throw Error("invalid manifest");
  if (
    manifest.scanState !== "complete" &&
    (!manifest.notice ||
      manifest.parts.some((p) => p.source !== "musinsa") ||
      manifest.scanCount !== (manifest.musinsaCount || 0))
  )
    throw Error("partial build requires notice and no scan files");
  const directory = path.dirname(outputPath),
    window = {},
    all = [...D.items],
    keys = new Set(),
    parts = new Set();
  function read(file, label) {
    if (
      !/^(?:4910\/(?:catalog-\d+|b\d+|index)|musinsa\/(?:catalog-\d+|h\d+))\.js$/.test(
        file,
      )
    )
      throw Error("invalid data path");
    const absolute = path.join(directory, file);
    if (!fs.existsSync(absolute)) throw Error("missing " + label + ": " + file);
    vm.runInNewContext(
      fs.readFileSync(absolute, "utf8"),
      { window },
      { timeout: 1000 },
    );
  }
  let count = 0;
  for (const ref of manifest.parts) {
    if (parts.has(ref.id)) throw Error("duplicate catalog part");
    parts.add(ref.id);
    read(ref.path, "catalog part");
    const p = window.__CLOT_CATALOG_PARTS__?.[ref.id];
    if (p?.revision !== manifest.revision)
      throw Error("catalog revision mismatch");
    if (p.v !== 1 || p.id !== ref.id || p.items.length !== ref.count)
      throw Error("catalog count mismatch");
    count += p.items.length;
    all.push(...p.items);
    delete window.__CLOT_CATALOG_PARTS__[ref.id];
  }
  if (count !== manifest.scanCount) throw Error("scan count mismatch");
  const details = new Map();
  for (const x of all) {
    if (
      !["musinsa", "4910"].includes(x.src) ||
      x.k !== model.itemKey(x.src, x.n) ||
      keys.has(x.k) ||
      "L" in x
    )
      throw Error("invalid summary identity");
    keys.add(x.k);
    let L;
    if (x.detail?.type === "inline") L = D.inlineHistories[x.k];
    else if (x.detail?.type === "brand") {
      const ref = x.detail;
      if (!details.has(ref.path)) {
        read(ref.path, "detail");
        const P = window.__CLOT_4910_B__?.[ref.brandSno];
        if (P?.revision !== manifest.revision || P.brandSno !== ref.brandSno)
          throw Error("detail revision mismatch");
        details.set(
          ref.path,
          new Map(
            P.r.map((r) => [
              model.itemKey("4910", r[0]),
              expandScanHistory(r[7]),
            ]),
          ),
        );
        delete window.__CLOT_4910_B__[ref.brandSno];
      }
      L = details.get(ref.path).get(x.k);
    } else if (x.detail?.type === "musinsa") {
      const ref = x.detail;
      if (!details.has(ref.path)) {
        read(ref.path, "detail");
        const P = window.__CLOT_MUSINSA_H__?.[ref.id];
        if (P?.v !== 1 || P.revision !== manifest.revision || P.id !== ref.id)
          throw Error("detail revision mismatch");
        details.set(ref.path, new Map(Object.entries(P.histories)));
        delete window.__CLOT_MUSINSA_H__[ref.id];
      }
      L = details.get(ref.path).get(x.k);
    } else throw Error("invalid detail reference");
    if (!Array.isArray(L)) throw Error("missing detail history");
    const derived = model.summarize(
      { ...x, L },
      { kind: x.kind, detail: x.detail,asOfMs:manifest.asOfMs??Date.now() },
    );
    for (const f of [
      "my",
      "sale",
      "normal",
      "newbie",
      "isOut",
      "isLow",
      "lowEligible",
      "dropAmt",
      "rate",
      "coupon",
      "couponName",
      "lowMy",
      "lowDate",
      "tracked",
      "priceSource",
      "observedDate",
    ]) {
      if (derived[f] !== x[f]) throw Error("summary history mismatch: " + f);
    }
  }
  return {
    totalItems: all.length,
    total4910: all.filter((x) => x.src === "4910").length,
    scanState: manifest.scanState,
  };
}
function verifyV2(D, directory) {
  const equal = (a, b) =>
    isDeepStrictEqual(
      JSON.parse(JSON.stringify(a ?? null)),
      JSON.parse(JSON.stringify(b ?? null)),
    );
  const m = D.catalog,
    model = createDashboardModel(),
    cache = new Map();
  if (
    Object.keys(D.inlineHistories || {}).length ||
    D.items.some((x) => "L" in x) ||
    D.items.length > 120
  )
    throw Error("inline history or bootstrap limit");
  function load(ref) {
    if (!/^assets\/[a-z-]+-\d+\.js$/.test(ref.path))
      throw Error("invalid asset path");
    if (cache.has(ref.id)) return cache.get(ref.id);
    const file = path.join(directory, ref.path);
    if (!fs.existsSync(file)) throw Error("missing asset " + ref.path);
    const s = fs.readFileSync(file, "utf8");
    if (Buffer.byteLength(s) !== ref.bytes || ref.bytes > 262144)
      throw Error("asset bytes mismatch");
    const c = {};
    vm.runInNewContext(s, c, { timeout: 1000 });
    const p = c.__CLOT_ASSETS__?.[ref.id];
    if (p?.revision !== m.revision || p.id !== ref.id || p.v !== 2)
      throw Error("asset revision mismatch");
    cache.set(ref.id, p);
    return p;
  }
  const rows = m.indexParts.flatMap((r) => {
      const rows = unpackIndex(load(r));
      if (rows.length !== r.count) throw Error("index count mismatch");
      if (
        m.loadingMode === "scoped" &&
        rows.some((x) => x.src !== r.source || x.c !== r.category)
      )
        throw Error("index partition mismatch");
      return rows;
    }),
    keys = new Set(),
    cards = new Map();
  for (const row of rows) {
    if (keys.has(row.k) || row.k !== model.itemKey(row.src, row.n))
      throw Error("invalid summary identity");
    keys.add(row.k);
    const part = load(row.card);
    for (const x of part.items) cards.set(x.k, x);
    const x = cards.get(row.k);
    if (!x) throw Error("missing card");
    for (const f of ["my", "sale", "priceSource", "observedDate"])
      if ((x[f] ?? null) !== (row[f] ?? null))
        throw Error("index card mismatch");
  }
  // Decode each history file once; verify complete original history and global summary semantics.
  const histories = new Map();
  for (const x of cards.values()) for (const r of x.detail.parts) load(r);
  for (const p of cache.values())
    if (p.id.startsWith("history-"))
      for (const [key, row] of p.rows) {
        if (!histories.has(key)) histories.set(key, []);
        histories.get(key).push(row);
      }
  for (const x of cards.values()) {
    const L = histories.get(x.k) || [];
    L.sort((a, b) => a[0].localeCompare(b[0]));
    const d = model.summarize({ ...x, L }, { kind: x.kind, detail: x.detail,asOfMs:m.asOfMs??Date.now() });
    for (const f of [
      "my",
      "sale",
      "normal",
      "newbie",
      "isOut",
      "isLow",
      "lowEligible",
      "dropAmt",
      "rate",
      "coupon",
      "couponName",
      "lowMy",
      "lowDate",
      "tracked",
      "priceSource",
      "observedDate",
    ])
      if (d[f] !== x[f])
        throw Error("summary history mismatch: " + x.k + " " + f);
  }
  if (rows.length !== m.totalItems || cards.size !== rows.length)
    throw Error("total count mismatch");
  const q = model.queryCatalog([...cards.values()], m.bootstrap.state,{asOfMs:m.asOfMs??Date.now()});
  for (const f of ["total", "sources", "quick", "categories", "brands"])
    if (!equal(q[f], m.bootstrap[f])) throw Error("bootstrap mismatch " + f);
  if (
    JSON.stringify(q.items.slice(0, 120).map((x) => x.k)) !==
    JSON.stringify(D.items.map((x) => x.k))
  )
    throw Error("bootstrap order mismatch");
  if (m.loadingMode === "scoped") {
    const scope = createDashboardScope(),
      routes = new Map();
    for (const [bucket, refs] of Object.entries(m.routes))
      for (const ref of refs) {
        const p = load(ref);
        if (!Array.isArray(p.entries) || p.entries.length !== ref.count)
          throw Error("route count mismatch");
        for (const [key, card] of p.entries) {
          if (
            scope.routeBucket(key) !== Number(bucket) ||
            routes.has(key) ||
            !load(card).items.some((x) => x.k === key)
          )
            throw Error("route target mismatch");
          routes.set(key, card);
        }
      }
    if (routes.size !== keys.size || [...keys].some((k) => !routes.has(k)))
      throw Error("route coverage mismatch");
    const preview = new Map(m.previewItems.map((x) => [x.k, x]));
    if (preview.size !== m.previewItems.length)
      throw Error("duplicate preview");
    for (const src of ["all", "musinsa", "4910"]) {
      const p = m.previews[src],
        { items, ...facets } = model.queryCatalog(
          [...cards.values()],
          model.restoreState({ src }),
          {asOfMs:m.asOfMs??Date.now()},
        );
      if (
        !equal(facets, p.facets) ||
        JSON.stringify(p.keys) !==
          JSON.stringify(items.slice(0, 120).map((x) => x.k))
      )
        throw Error("preview mismatch");
      for (const key of p.keys)
        if (!equal(preview.get(key), cards.get(key)))
          throw Error("preview card mismatch");
    }
  }
  return {
    totalItems: rows.length,
    total4910: rows.filter((x) => x.src === "4910").length,
    scanState: m.scanState,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    console.log(JSON.stringify(verifyDashboardBuild(process.argv[2])));
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}
