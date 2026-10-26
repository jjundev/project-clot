import './setup-env.js';
import {freshTracking} from './helpers/dashboard-fixture.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createDashboardBuilder } from "../src/dashboard-builder.js";
import { createDashboardModel } from "../src/dashboard-model.js";
import { createDashboardIndex } from "../src/dashboard-index.js";
const model = createDashboardModel(),
  index = createDashboardIndex(model);
function fixture(t, count = 260) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = createDashboardBuilder({ outDir: dir, revision: "scope-test" });
  for (let n = 0; n < count; n++)
    b.add({
      src: n % 2 ? "4910" : "musinsa",
      n,
      tracking:freshTracking(n%5?90:0,null),
      b: "Brand " + (n % 3),
      g: "Product " + n,
      c: n % 3 ? "top" : "etc",
      L: [["2026-10-16", 200, 100, n % 5 ? 90 : 0, n % 7 ? 0 : 1, null, 0]],
    });
  const data = b.finish({ scanState: "complete" });
  const read = (ref) => {
    const s = fs.readFileSync(path.join(dir, ref.path), "utf8"),
      ctx = {};
    vm.runInNewContext(s, ctx);
    return {
      payload: JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id])),
      bytes: Buffer.byteLength(s),
    };
  };
  return { dir, data, read };
}
test("scoped build preserves every identity and partitions by source and category", (t) => {
  const { data, read } = fixture(t);
  assert.equal(data.catalog.loadingMode, "scoped");
  const keys = [];
  for (const ref of data.catalog.indexParts) {
    const rows = index.unpackIndex(read(ref).payload);
    assert.equal(rows.length, ref.count);
    for (const x of rows) {
      assert.equal(x.src, ref.source);
      assert.equal(x.c, ref.category);
      keys.push(x.k);
    }
  }
  assert.equal(keys.length, 260);
  assert.equal(new Set(keys).size, 260);
  assert.ok(data.catalog.indexParts.some((r) => r.category === "etc"));
});
test("previews share cards and preserve exact first-page order", (t) => {
  const { data, read } = fixture(t);
  const all = data.catalog.indexParts.flatMap((r) =>
    index.unpackIndex(read(r).payload),
  );
  assert.ok(data.catalog.previews);
  for (const src of ["all", "musinsa", "4910"])
    assert.deepEqual(
      data.catalog.previews[src].keys,
      model
        .queryCatalog(all, { src })
        .items.slice(0, 120)
        .map((x) => x.k),
    );
  assert.equal(
    new Set(data.catalog.previewItems.map((x) => x.k)).size,
    data.catalog.previewItems.length,
  );
});
test("routes find offscreen products without search indexes", async (t) => {
  const { data, read } = fixture(t);
  assert.ok(data.catalog.routes);
  const { createDashboardScope } = await import("../src/dashboard-scope.js");
  const scope = createDashboardScope();
  assert.equal(scope.routeBucket(""), 197);
  const entries = Object.values(data.catalog.routes).flatMap((refs) =>
    refs.flatMap((r) => read(r).payload.entries),
  );
  assert.equal(entries.length, 260);
  for (const [key, ref] of entries) {
    assert.ok(read(ref).payload.items.some((x) => x.k === key));
    assert.ok(data.catalog.routes[scope.routeBucket(key)]);
  }
});
test("empty scopes and oversized route buckets stay valid", async (t) => {
  const { data, dir } = fixture(t, 0);
  assert.deepEqual(data.catalog.routes, {});
  assert.deepEqual(data.catalog.previews.musinsa.keys, []);
  assert.equal(data.catalog.indexParts.length, 0);
  for (const f of fs.readdirSync(path.join(dir, "assets")))
    assert.ok(fs.statSync(path.join(dir, "assets", f)).size <= 262144);
});
export { fixture, model, index };
import { createDashboardTransport } from "../src/dashboard-worker.js";
async function transportFixture(t, options = {}) {
  const f = fixture(t, options.count ?? 520),
    scope = (await import("../src/dashboard-scope.js")).createDashboardScope();
  const calls = [];
  const engine = await createDashboardTransport({
    manifest: f.data.catalog,
    index,
    scope,
    loadAsset: async (ref) => {
      calls.push(ref);
      return options.load ? options.load(ref, f.read) : f.read(ref);
    },
  });
  return { ...f, engine, calls, scope };
}
test("scoped init does not fetch indexes", async (t) => {
  const { calls } = await transportFixture(t);
  assert.equal(calls.length, 0);
});
test("musinsa top query fetches only matching parts and incomplete cross facets are null", async (t) => {
  const { engine, calls, data } = await transportFixture(t);
  const r = await engine.query({ src: "musinsa", cat: "top" }, 1);
  assert.equal(r.total, 173);
  assert.equal(r.sources.musinsa, 173);
  assert.equal(r.sources["4910"], null);
  assert.equal(r.sources.all, null);
  assert.equal(r.categories.etc, null);
  assert.equal(r.categories.shoes, 0);
  assert.deepEqual(
    calls.filter((x) => x.id.startsWith("index")).map((x) => x.id),
    data.catalog.indexParts
      .filter((x) => x.source === "musinsa" && x.category === "top")
      .map((x) => x.id),
  );
  assert.ok(calls.every((x) => !x.id.startsWith("history")));
});
test("scope widening reuses loaded files and complete results preserve all sorts", async (t) => {
  const { engine, calls, data, read } = await transportFixture(t);
  await engine.query({ src: "musinsa", cat: "top" });
  await engine.query({ src: "musinsa" });
  for (const sort of [
    "category",
    "rate",
    "priceAsc",
    "priceDesc",
    "dropAmt",
    "brand",
    "new",
  ]) {
    const state = { src: "all", sort, q: "product", filter: "all" },
      r = await engine.query(state),
      all = data.catalog.indexParts.flatMap((ref) =>
        index.unpackIndex(read(ref).payload),
      );
    const expected = model.queryCatalog(all, state);
    assert.equal(r.total, expected.total);
    assert.deepEqual(
      r.items.map((x) => x.k),
      expected.items.slice(0, 120).map((x) => x.k),
    );
    assert.deepEqual(r.sources, expected.sources);
  }
  const ids = calls.filter((x) => x.id.startsWith("index")).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
});
test("lookup uses only route and card files", async (t) => {
  const { engine, calls } = await transportFixture(t);
  assert.equal((await engine.lookup("musinsa:518")).k, "musinsa:518");
  assert.equal(await engine.lookup("musinsa:999999"), null);
  assert.ok(
    calls.every(
      (x) => !x.id.startsWith("index") && !x.id.startsWith("history"),
    ),
  );
});
test("failed part is retryable and never counted as complete", async (t) => {
  let fail = true;
  const { engine, calls } = await transportFixture(t, {
    load: (ref, read) => {
      if (fail && ref.id.startsWith("index")) {
        fail = false;
        throw Error("offline");
      }
      return read(ref);
    },
  });
  await assert.rejects(engine.query({ src: "musinsa", cat: "top" }), /offline/);
  assert.equal((await engine.query({ src: "musinsa", cat: "top" })).total, 173);
  assert.equal(calls.filter((x) => x.id.startsWith("index")).length, 2);
});
test("latest scope bypasses obsolete queued downloads", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  let active = 0,
    max = 0;
  const { engine, calls, data } = await transportFixture(t, {
    count: 12000,
    load: async (ref, read) => {
      max = Math.max(max, ++active);
      if (ref.id.startsWith("index")) await gate;
      active--;
      return read(ref);
    },
  });
  const old = engine.query({ src: "all" }, 1);
  const rejected = assert.rejects(old, { code: "STALE_RESULT" });
  await new Promise((r) => setImmediate(r));
  const newest = engine.query({ src: "4910", cat: "etc" }, 2);
  release();
  await rejected;
  const result = await newest;
  assert.ok(result.items.every((x) => x.src === "4910" && x.c === "etc"));
  assert.ok(max <= 8);
  const wanted = new Set(
    data.catalog.indexParts
      .filter((x) => x.source === "4910" && x.category === "etc")
      .map((x) => x.id),
  );
  assert.ok(
    calls
      .filter((x) => x.id.startsWith("index"))
      .slice(8)
      .every((x) => wanted.has(x.id)),
  );
});
test("superseded query settles before active downloads complete", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine } = await transportFixture(t, {
    load: async (ref, read) => {
      if (ref.id.startsWith("index")) await gate;
      return read(ref);
    },
  });
  const old = engine.query({ src: "musinsa", cat: "top" });
  const rejected = assert.rejects(old, { code: "STALE_RESULT" });
  const newest = engine.query({ src: "4910", cat: "top" });
  try {
    assert.equal(
      await Promise.race([
        rejected.then(() => true),
        new Promise((r) => setTimeout(() => r(false), 20)),
      ]),
      true,
    );
  } finally {
    release();
    await newest;
    await rejected;
  }
});
test("scoped queries preserve substring, brands, quick filters and zero prices", async (t) => {
  const { engine, data, read } = await transportFixture(t);
  const rows = data.catalog.indexParts.flatMap((r) =>
    index.unpackIndex(read(r).payload),
  );
  for (const sort of [
    "category",
    "rate",
    "priceAsc",
    "priceDesc",
    "dropAmt",
    "brand",
    "new",
  ])
    for (const filter of ["all", "lowest", "drop", "onsale", "out"]) {
      const state = {
          src: "musinsa",
          cat: "top",
          brandKeys: ["brand 1", "brand 2"],
          q: "duct",
          filter,
          sort,
        },
        want = model.queryCatalog(rows, state),
        got = await engine.query(state);
      for (const key of ["total", "quick", "brands"])
        assert.deepEqual(got[key], want[key]);
      assert.deepEqual(
        got.items.map((x) => x.k),
        want.items.slice(0, 120).map((x) => x.k),
      );
    }
});
test("scope widening shares inflight files and corrupt revision is retryable", async (t) => {
  let release;
  const gate = new Promise((r) => (release = r));
  const { engine, calls } = await transportFixture(t, {
    load: async (ref, read) => {
      if (ref.id.startsWith("index")) await gate;
      return read(ref);
    },
  });
  const old = engine.query({ src: "musinsa", cat: "top" }),
    rejected = assert.rejects(old, { code: "STALE_RESULT" }),
    wide = engine.query({ src: "musinsa" });
  release();
  await rejected;
  assert.equal((await wide).total, 260);
  const ids = calls.filter((x) => x.id.startsWith("index")).map((x) => x.id);
  assert.equal(new Set(ids).size, ids.length);
  let corrupt = true;
  const other = await transportFixture(t, {
    load: (ref, read) => {
      const v = read(ref);
      if (corrupt && ref.id.startsWith("index")) v.payload.revision = "old";
      return v;
    },
  });
  await assert.rejects(other.engine.query({ src: "musinsa" }), /버전/);
  corrupt = false;
  assert.equal((await other.engine.query({ src: "musinsa" })).total, 260);
});
test("oversized route bucket is split into valid bounded files", async (t) => {
  const { createDashboardScope } = await import("../src/dashboard-scope.js");
  const scope = createDashboardScope(),
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "route-split-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = createDashboardBuilder({ outDir: dir, revision: "r" });
  let count = 0;
  for (let n = 0; count < 3000; n++)
    if (scope.routeBucket("musinsa:" + n) === 0) {
      b.add({ src: "musinsa", n, b: "b", g: "g", L: [] });
      count++;
    }
  const D = b.finish({ scanState: "complete" });
  assert.ok(D.catalog.routes[0].length > 1);
  assert.equal(
    D.catalog.routes[0].reduce((n, r) => n + r.count, 0),
    3000,
  );
  for (const r of D.catalog.routes[0]) assert.ok(r.bytes <= 262144);
});
test("partitioned verification compares facet values independently of insertion order", async (t) => {
  const { verifyDashboardBuild } = await import(
    "../scripts/verify-dashboard-build.js"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-facets-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = createDashboardBuilder({ outDir: dir, revision: "r" });
  for (let n = 0; n < 12; n++)
    b.add({
      src: "musinsa",
      n,
      tracking:freshTracking(n%5?90:0,null),
      b: "Brand",
      g: "긴".repeat(10000),
      c: n < 3 || n === 6 || n >= 9 ? "top" : n < 6 ? "outer" : "etc",
      L: [["2026-10-16", 200, 100, 90, 0, null, 0, null, "DIRECT"]],
    });
  const D = b.finish({ scanState: "complete" });
  const file = path.join(dir, "index.html");
  fs.writeFileSync(file, "window.__CLOT_DATA__ = " + JSON.stringify(D) + ";\n");
  assert.equal(verifyDashboardBuild(file).totalItems, 12);
});
test("verifier accepts untracked cards with absent optional price fields", async (t) => {
  const { verifyDashboardBuild } = await import(
    "../scripts/verify-dashboard-build.js"
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "scope-untracked-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = createDashboardBuilder({ outDir: dir, revision: "r" });
  b.add({ src: "musinsa", n: 1, L: [] });
  const D = b.finish({ scanState: "complete" }),
    file = path.join(dir, "index.html");
  fs.writeFileSync(file, "window.__CLOT_DATA__ = " + JSON.stringify(D) + ";\n");
  assert.equal(verifyDashboardBuild(file).totalItems, 1);
});
test("new scope downloads precede the obsolete card backlog", async () => {
  const { createDashboardScope } = await import("../src/dashboard-scope.js");
  const makeRef = (id, count) => ({
    id,
    path: "assets/" + id + ".js",
    bytes: 1,
    count,
  });
  const rows = Array.from({ length: 13 }, (_, n) => ({
    ...model.summarize({
      src: n === 12 ? "4910" : "musinsa",
      n,
      tracking:freshTracking(n%5?90:0,null),
      b: "b",
      g: "g",
      c: "top",
      L: [["2026-10-16",200,100,n%5?90:0,0,null,0]],
    }),
    card: makeRef("cards-" + n, 1),
  }));
  const refs = [
    { ...makeRef("index-0", 12), source: "musinsa", category: "top" },
    { ...makeRef("index-1", 1), source: "4910", category: "top" },
  ];
  const releases = [],
    gates = rows.map((_, n) => new Promise((r) => (releases[n] = r))),
    calls = [];
  const engine = await createDashboardTransport({
    manifest: {
      v: 2,
      loadingMode: "scoped",
      revision: "r",
      indexParts: refs,
      bootstrap: { items: [] },
      routes: {},
    },
    scope: createDashboardScope(),
    index,
    loadAsset: async (ref) => {
      calls.push(ref.id);
      if (ref.id.startsWith("index"))
        return {
          payload: index.packIndex(
            ref.id === "index-0" ? rows.slice(0, 12) : rows.slice(12),
            { revision: "r", id: ref.id },
          ),
          bytes: 1,
        };
      const n = Number(ref.id.split("-")[1]);
      await gates[n];
      return {
        payload: { v: 2, revision: "r", id: ref.id, items: [rows[n]] },
        bytes: 1,
      };
    },
  });
  const old = engine.query({ src: "musinsa" }),
    rejected = assert.rejects(old, { code: "STALE_RESULT" });
  await new Promise((r) => setImmediate(r));
  const latest = engine.query({ src: "4910" });
  releases[0]();
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[9], "index-1");
  } finally {
    for (const r of releases) r();
    await rejected;
    await latest;
  }
});
test("direct lookup bypasses the queued whole-catalog index backlog", async () => {
  const { createDashboardScope } = await import("../src/dashboard-scope.js"),
    scope = createDashboardScope(),
    ref = (id, count = 1) => ({
      id,
      path: "assets/" + id + ".js",
      bytes: 1,
      count,
    });
  const rows = Array.from({ length: 12 }, (_, n) => ({
      ...model.summarize({
        src: "musinsa",
        n,
        b: "b",
        g: "g",
        c: "top",
        L: [["2026-10-16",200,100,n%5?90:0,0,null,0]],
      }),
      card: ref("cards-" + n),
    })),
    parts = rows.map((_, n) => ({
      ...ref("index-" + n),
      source: "musinsa",
      category: "top",
    })),
    route = ref("routes-0");
  const releases = [],
    gates = rows.map((_, n) => new Promise((r) => (releases[n] = r))),
    calls = [];
  const engine = await createDashboardTransport({
    manifest: {
      v: 2,
      loadingMode: "scoped",
      revision: "r",
      indexParts: parts,
      bootstrap: { items: [] },
      routes: { [scope.routeBucket("musinsa:7")]: [route] },
    },
    scope,
    index,
    loadAsset: async (r) => {
      calls.push(r.id);
      const n = Number(r.id.split("-")[1]);
      if (r.id.startsWith("index")) {
        await gates[n];
        return {
          payload: index.packIndex([rows[n]], { revision: "r", id: r.id }),
          bytes: 1,
        };
      }
      return {
        payload: {
          v: 2,
          revision: "r",
          id: r.id,
          ...(r.id.startsWith("routes")
            ? { entries: [["musinsa:7", rows[7].card]] }
            : { items: [rows[n]] }),
        },
        bytes: 1,
      };
    },
  });
  const search = engine.query({ src: "all" });
  await new Promise((r) => setImmediate(r));
  const lookup = engine.lookup("musinsa:7");
  releases[0]();
  try {
    await new Promise((r) => setImmediate(r));
    assert.equal(calls[8], "routes-0");
    assert.equal(
      await Promise.race([
        lookup.then((x) => x.k),
        new Promise((r) => setTimeout(() => r("blocked"), 30)),
      ]),
      "musinsa:7",
    );
  } finally {
    for (const r of releases) r();
    await search;
    await lookup;
  }
});

test('cancelQuery settles before active downloads and removes queued indexes',async t=>{
 let release;const gate=new Promise(r=>release=r);
 const {engine,calls}=await transportFixture(t,{count:12000,load:async(ref,read)=>{if(ref.id.startsWith('index'))await gate;return read(ref);}});
 const old=engine.query({src:'all'}),rejected=assert.rejects(old,{code:'STALE_RESULT'});
 await new Promise(r=>setImmediate(r));
 try {
  await engine.cancelQuery();
  assert.equal(await Promise.race([rejected.then(()=>true),new Promise(r=>setTimeout(()=>r(false),100))]),true);
 }finally{release();await rejected;}
 const item=await engine.lookup('musinsa:11998');assert.equal(item.k,'musinsa:11998');
 assert.equal(calls.filter(ref=>ref.id.startsWith('index')).length,8);
});
test('direct lookup ignores blocked indexes after query failure',async t=>{
 const {engine,calls}=await transportFixture(t,{load:(ref,read)=>{if(ref.id.startsWith('index'))throw Error('blocked index');return read(ref);}});
 await assert.rejects(engine.query({}),/blocked index/);await engine.cancelQuery();
 const count=calls.length;assert.equal((await engine.lookup('musinsa:518')).k,'musinsa:518');
 assert.ok(calls.slice(count).every(ref=>!ref.id.startsWith('index')));
});
function tierFixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tier-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const asOfMs = Date.parse("2026-10-26T00:00:00Z"), H = 3600e3,
    b = createDashboardBuilder({ outDir: dir, revision: "tier", asOfMs }),
    L = [["2026-10-25", 200, 100, 90, 0, null, 0]];
  for (let n = 0; n < 40; n++)
    b.add({ src: "musinsa", n, b: "A", g: "P" + n, c: "top", L,
      tracking: freshTracking(90, null, { at: n % 4 ? asOfMs : asOfMs - 72 * H }) });
  const data = b.finish({ scanState: "complete" });
  const read = (ref) => {
    const s = fs.readFileSync(path.join(dir, ref.path), "utf8"), ctx = {};
    vm.runInNewContext(s, ctx);
    return { payload: JSON.parse(JSON.stringify(ctx.__CLOT_ASSETS__[ref.id])), bytes: Buffer.byteLength(s) };
  };
  return { data, read, asOfMs, H };
}
test("index parts split by freshness tier and expose exactUntilMs", (t) => {
  const { data, read, asOfMs, H } = tierFixture(t);
  const counts = {};
  for (const r of data.catalog.indexParts) {
    counts[r.tier] = (counts[r.tier] || 0) + r.count;
    for (const x of index.unpackIndex(read(r).payload))
      assert.equal(model.freshWindow(x)?.until >= asOfMs ? "live" : "history", r.tier);
  }
  assert.deepEqual(counts, { live: 30, history: 10 });
  assert.equal(data.catalog.exactUntilMs, asOfMs - H + 48 * H);
});
test("selectParts skips history unless included or the clock precedes the build", async () => {
  const scope = (await import("../src/dashboard-scope.js")).createDashboardScope();
  const m = { asOfMs: 100, indexParts: [
    { id: "a", source: "musinsa", category: "top", tier: "live" },
    { id: "b", source: "musinsa", category: "top", tier: "history" },
    { id: "c", source: "musinsa", category: "top" }] };
  const ids = (s, nowMs) => scope.selectParts(m, s, { nowMs }).map((r) => r.id);
  assert.deepEqual(ids({}, 200), ["a", "c"]);
  assert.deepEqual(ids({ includeHistory: true }, 200), ["a", "b", "c"]);
  assert.deepEqual(ids({}, 50), ["a", "b", "c"]);
  assert.equal(scope.facetCoverage(m, new Set(["a", "c"]), {}, { nowMs: 200 }).sources.musinsa, true);
});
test("default query never requests history parts; includeHistory adds only them", async (t) => {
  const { data, read, asOfMs } = tierFixture(t), calls = [];
  const scope = (await import("../src/dashboard-scope.js")).createDashboardScope();
  const engine = await createDashboardTransport({ manifest: data.catalog, index, scope,
    loadAsset: async (ref) => { calls.push(ref.id); return read(ref); } });
  const tierOf = (id) => data.catalog.indexParts.find((r) => r.id === id)?.tier;
  assert.equal((await engine.query({}, 1, asOfMs + 1)).total, 30);
  assert.ok(calls.filter((id) => id.startsWith("index")).every((id) => tierOf(id) === "live"));
  const before = calls.length;
  assert.equal((await engine.query({ includeHistory: true }, 2, asOfMs + 1)).total, 40);
  assert.ok(calls.slice(before).filter((id) => id.startsWith("index")).every((id) => tierOf(id) === "history"));
});
import { createDashboardScope } from "../src/dashboard-scope.js";
const scope = createDashboardScope();
const syntheticItem = (i) => ({
  ...model.summarize({ src: "musinsa", n: i, b: "A", g: "P" + i, c: "top", L: [] }),
  card: { id: "cards-" + i, path: "assets/cards-" + i + ".js", bytes: 1, count: 1 },
});
function synthetic(n) {
  const indexParts = Array.from({ length: n }, (_, i) => ({
    id: "index-" + i, path: "assets/index-" + i + ".js",
    source: "musinsa", category: "top", tier: "live", bytes: 1, count: 1,
  }));
  return { v: 2, revision: "r", asOfMs: 0, loadingMode: "scoped", bootstrap: { items: [] }, indexParts };
}
function syntheticAsset(ref) {
  const i = Number(ref.id.split("-").pop());
  return ref.id.startsWith("index")
    ? { payload: index.packIndex([syntheticItem(i)], { revision: "r", id: ref.id }), bytes: 1 }
    : { payload: { v: 2, revision: "r", id: ref.id, items: [syntheticItem(i)] }, bytes: 1 };
}
test("scoped downloads run at most eight at a time", async () => {
  let active = 0, max = 0;
  const engine = await createDashboardTransport({ manifest: synthetic(12), index, scope,
    loadAsset: async (ref) => { max = Math.max(max, ++active); await new Promise((r) => setTimeout(r, 5)); active--; return syntheticAsset(ref); } });
  await engine.query({ includeHistory: true }, 1, Date.now());
  assert.equal(max, 8);
});
test("progress reports monotonic counts for the active request", async () => {
  const events = [];
  const engine = await createDashboardTransport({ manifest: synthetic(12), index, scope,
    loadAsset: async (ref) => syntheticAsset(ref), onProgress: (p) => events.push(p) });
  await engine.query({ includeHistory: true }, 7, Date.now());
  assert.ok(events.every((e) => e.requestId === 7 && e.total === 12));
  assert.deepEqual(events.map((e) => e.loaded), [...Array(13).keys()]);
});
import { createDashboardRuntime } from "../src/dashboard-runtime.js";
import { createHistoryLoader } from "../src/dashboard-history.js";
test("exactPreview returns the build result only for default state inside the exact window", async (t) => {
  const { data } = fixture(t), m = data.catalog, calls = [];
  const api = createDashboardRuntime({ manifest: m, model, indexFactory: createDashboardIndex,
    scopeFactory: createDashboardScope, historyFactory: createHistoryLoader,
    transportFactory: createDashboardTransport, loadAsset: async (ref) => { calls.push(ref.id); throw Error("no"); } });
  const r = api.exactPreview({ src: "musinsa" }, m.asOfMs + 1);
  assert.deepEqual(r.items.map((x) => x.k), m.previews.musinsa.keys);
  assert.equal(r.total, m.previews.musinsa.facets.total);
  assert.equal(r.nextOffset, r.total > 120 ? 120 : null);
  for (const [s, now] of [[{ src: "musinsa", cat: "top" }, m.asOfMs + 1], [{ src: "musinsa", sort: "priceAsc" }, m.asOfMs + 1],
    [{ src: "musinsa" }, m.exactUntilMs], [{ src: "musinsa" }, m.asOfMs - 1]])
    assert.equal(api.exactPreview(s, now), null);
  assert.deepEqual(calls, []);
  api.dispose();
});
