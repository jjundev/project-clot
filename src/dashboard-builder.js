import fs from "node:fs";
import path from "node:path";
import { createAssetWriter } from "./dashboard-assets.js";
import { createHistoryExporter } from "./dashboard-history.js";
import { createDashboardModel } from "./dashboard-model.js";
import { createDashboardScope } from "./dashboard-scope.js";
import { packIndex } from "./dashboard-index.js";
/** Build-time sink: retains current summaries, never the whole archive. */
export function createDashboardBuilder({ outDir, revision }) {
  const writer = createAssetWriter({ outDir, revision }),
    history = createHistoryExporter({ writer }),
    model = createDashboardModel(),
    summaries = [];
  let cards = [],
    size = 400;
  fs.rmSync(path.join(outDir, "assets"), { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "assets"), { recursive: true });
  function splitWrite(kind, items, record) {
    try {
      return [{ ref: writer.writeRecord(kind, record(items)), items }];
    } catch (error) {
      if (!error.message.includes("exceeds byte limit") || items.length < 2)
        throw error;
      const mid = Math.ceil(items.length / 2);
      return [
        ...splitWrite(kind, items.slice(0, mid), record),
        ...splitWrite(kind, items.slice(mid), record),
      ];
    }
  }
  function flush() {
    if (!cards.length) return;
    history.finish();
    for (const { ref, items } of splitWrite("cards", cards, (items) => ({
      items,
    })))
      for (const x of items) summaries.push({ ...x, card: ref });
    cards = [];
    size = 400;
  }

  return {
    checkpoint() {
      history.finish();
      flush();
      return {
        count: summaries.length,
        files: new Set(fs.readdirSync(path.join(outDir, "assets"))),
      };
    },
    rollback(point) {
      history.finish();
      flush();
      summaries.splice(point.count);
      for (const file of fs.readdirSync(path.join(outDir, "assets")))
        if (!point.files.has(file))
          fs.unlinkSync(path.join(outDir, "assets", file));
    },
    add(raw, options) {
      const detail = history.add(model.itemKey(raw.src, raw.n), raw.L || []),
        x = model.summarize(raw, { ...options, detail });
      const bytes = Buffer.byteLength(JSON.stringify(x)) + 1;
      if (cards.length && size + bytes > 230000) flush();
      cards.push(x);
      size += bytes;
    },
    finish({ scanState, notice, musinsaCount = 0, scanCount = 0 }) {
      history.finish();
      flush();
      const indexParts = [],
        groups = new Map();
      for (const x of summaries) {
        const k = x.src + ":" + x.c;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(x);
      }
      for (const group of groups.values())
        for (let i = 0; i < group.length; i += 1200) {
          for (const { ref } of splitWrite(
            "index",
            group.slice(i, i + 1200),
            (items) => {
              const {
                v,
                revision: r,
                id,
                ...data
              } = packIndex(items, { revision, id: "pending" });
              return data;
            },
          ))
            indexParts.push({
              ...ref,
              source: group[0].src,
              category: group[0].c,
            });
        }
      const state = model.restoreState({}),
        q = model.queryCatalog(summaries, state),
        { items, ...facets } = q;
      const previews = {},
        previewCards = new Map(),
        routes = {},
        buckets = new Map(),
        scope = createDashboardScope();
      for (const src of ["all", "musinsa", "4910"]) {
        const state = model.restoreState({ src }),
          { items, ...facets } = model.queryCatalog(summaries, state);
        const first = items.slice(0, 120);
        previews[src] = { state, keys: first.map((x) => x.k), facets };
        for (const { card, ...x } of first) previewCards.set(x.k, x);
      }
      for (const x of summaries) {
        const bucket = scope.routeBucket(x.k);
        if (!buckets.has(bucket)) buckets.set(bucket, []);
        buckets.get(bucket).push([x.k, x.card]);
      }
      for (const [bucket, entries] of buckets)
        routes[bucket] = splitWrite("routes", entries, (entries) => ({
          entries,
        })).map((x) => x.ref);
      const first = items.slice(0, 120).map(({ card, ...x }) => x);
      return {
        catalog: {
          v: 2,
          revision,
          scanState,
          notice,
          totalItems: summaries.length,
          indexParts,
          loadingMode: "scoped",
          routes,
          previews,
          previewItems: [...previewCards.values()],
          bootstrap: { state, ...facets, items: first },
          workerPath: "dashboard-worker.js",
          musinsaCount,
          scanCount,
        },
        items: first,
        inlineHistories: {},
      };
    },
  };
}
