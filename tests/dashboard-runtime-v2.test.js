import './setup-env.js';
import { createDashboardTransport } from "../src/dashboard-worker.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardRuntime } from "../src/dashboard-runtime.js";
import { createDashboardModel } from "../src/dashboard-model.js";
import { createDashboardIndex, packIndex } from "../src/dashboard-index.js";
import { createHistoryLoader } from "../src/dashboard-history.js";
test("bootstrap survives stalled index and async query pages preserve identity", async () => {
  const model = createDashboardModel(),
    items = Array.from({ length: 121 }, (_, n) => ({
      ...model.summarize({
        src: "musinsa",
        n,
        b: "브랜드",
        g: "상품" + n,
        L: [],
      }),
      card: { id: "cards-0", path: "assets/cards-0.js", count: 121, bytes: 1 },
    }));
  const q = model.queryCatalog(items, {});
  let release;
  const gate = new Promise((r) => (release = r));
  const manifest = {
    v: 2,
    revision: "r",
    indexParts: [
      { id: "index-0", path: "assets/index-0.js", bytes: 1, count: 121 },
    ],
    bootstrap: { ...q, items: q.items.slice(0, 120) },
  };
  const api = createDashboardRuntime({
    manifest,
    model,
    transportFactory: createDashboardTransport,
    indexFactory: createDashboardIndex,
    historyFactory: createHistoryLoader,
    loadAsset: async (ref) => {
      if (ref.id === "index-0") {
        await gate;
        return {
          payload: packIndex(items, { revision: "r", id: ref.id }),
          bytes: 1,
        };
      }
      return { payload: { v: 2, revision: "r", id: ref.id, items }, bytes: 1 };
    },
  });
  const pending = api.start();
  assert.equal(api.getState().bootstrap.items.length, 120);
  assert.equal("items" in api.getState(), false);
  release();
  await pending;
  const r = await api.query({});
  assert.equal(r.total, 121);
  assert.equal((await api.page(r.resultId, 120)).items.length, 1);
  assert.equal((await api.lookup("musinsa:120")).n, 120);
  await api.query({ q: "other" });
  await assert.rejects(api.page(r.resultId, 0), { code: "STALE_RESULT" });
  api.dispose();
});
test("transport reuses bootstrap cards and fetches other card files with bounded concurrency", async () => {
  const model = createDashboardModel(),
    index = createDashboardIndex(model),
    items = Array.from({ length: 8 }, (_, n) => ({
      ...model.summarize({
        src: "musinsa",
        n,
        b: "브랜드",
        g: "상품" + n,
        L: [],
      }),
      card: {
        id: "cards-" + n,
        path: "assets/cards-" + n + ".js",
        count: 1,
        bytes: 1,
      },
    }));
  let cardCalls = 0,
    active = 0,
    max = 0;
  const manifest = {
    v: 2,
    revision: "r",
    totalItems: 8,
    indexParts: [
      { id: "index-0", path: "assets/index-0.js", bytes: 1, count: 8 },
    ],
    bootstrap: { items },
  };
  const loadAsset = async (ref) => {
    if (ref.id === "index-0")
      return {
        payload: packIndex(items, { revision: "r", id: ref.id }),
        bytes: 1,
      };
    cardCalls++;
    max = Math.max(max, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return {
      payload: {
        v: 2,
        revision: "r",
        id: ref.id,
        items: [items.find((x) => x.card.id === ref.id)],
      },
      bytes: 1,
    };
  };
  const seeded = await createDashboardTransport({ manifest, index, loadAsset });
  assert.equal((await seeded.query({})).total, 8);
  assert.equal(cardCalls, 0);
  const fresh = await createDashboardTransport({
    manifest: { ...manifest, bootstrap: { items: [] } },
    index,
    loadAsset,
  });
  await fresh.query({});
  assert.ok(max > 1 && max <= 4);
});
import { createDashboardScope } from "../src/dashboard-scope.js";
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
};
function runtimeHarness(t) {
  const queries = [],
    events = [];
  let starts = 0;
  const api = createDashboardRuntime({
    manifest: {
      v: 2,
      loadingMode: "scoped",
      revision: "r",
      bootstrap: { items: [] },
    },
    model: createDashboardModel(),
    indexFactory: createDashboardIndex,
    scopeFactory: createDashboardScope,
    historyFactory: createHistoryLoader,
    loadAsset: async () => {
      throw Error("unexpected history");
    },
    transportFactory: async () => {
      starts++;
      return {
        query: () => {
          const d = deferred();
          queries.push(d);
          return d.promise;
        },
        lookup: async () => null,
      };
    },
    onChange: (s) => events.push(s),
  });
  t.after(() => api.dispose());
  return { api, queries, events, starts: () => starts };
}
test("runtime separates worker ready from scope ready", async (t) => {
  const { api, queries } = runtimeHarness(t);
  await api.start();
  assert.equal(api.getState().phase, "preview");
  const p = api.query({ src: "musinsa" });
  await new Promise((r) => setImmediate(r));
  assert.equal(api.getState().status, "loading");
  assert.equal(api.getState().phase, "query");
  queries[0].resolve({ total: 1 });
  await p;
  assert.equal(api.getState().status, "ready");
});
test("late query success or error cannot replace current state", async (t) => {
  const { api, queries } = runtimeHarness(t);
  const old = api.query({ q: "old" });
  const caught = assert.rejects(old, { code: "STALE_RESULT" });
  await new Promise((r) => setImmediate(r));
  const latest = api.query({ q: "latest" });
  await new Promise((r) => setImmediate(r));
  queries[1].resolve({ total: 2 });
  await latest;
  queries[0].reject(Error("late failure"));
  await caught;
  assert.equal(api.getState().status, "ready");
  assert.equal(api.getState().error, null);
});
test("dispose rejects pending work without later emissions", async (t) => {
  const { api, queries, events } = runtimeHarness(t);
  const p = api.query({});
  const rejected = assert.rejects(p, /disposed|stopped/i);
  await new Promise((r) => setImmediate(r));
  api.dispose();
  const n = events.length;
  queries[0].resolve({});
  await rejected;
  assert.equal(events.length, n);
});
test("history lookup does not prepare search scope", async (t) => {
  const { api, queries } = runtimeHarness(t);
  await assert.rejects(api.getHistory("musinsa:999"), /찾을 수/);
  assert.equal(queries.length, 0);
});
test("worker error settles pending calls and retry recreates transport", async (t) => {
  const workers = [],
    events = [];
  const api = createDashboardRuntime({
    manifest: {
      v: 2,
      loadingMode: "scoped",
      workerPath: "worker.js",
      revision: "r",
      bootstrap: { items: [] },
    },
    model: createDashboardModel(),
    historyFactory: createHistoryLoader,
    loadAsset: async () => {},
    onChange: (s) => events.push(s),
    createWorker: () => {
      const w = {
        terminate() {
          this.stopped = true;
        },
        postMessage(message) {
          this.messages.push(message);
          if (message.method === "init")
            queueMicrotask(() =>
              this.onmessage({
                data: { requestId: message.requestId, ok: true, result: true },
              }),
            );
        },
        messages: [],
      };
      workers.push(w);
      return w;
    },
  });
  t.after(() => api.dispose());
  const pending = api.query({ src: "4910" }),
    failed = assert.rejects(pending, /Worker/);
  await new Promise((r) => setImmediate(r));
  workers[0].onerror({ preventDefault() {} });
  await failed;
  assert.equal(api.getState().status, "error");
  assert.equal(workers[0].stopped, true);
  const retry = api.retryCatalog();
  await new Promise((r) => setImmediate(r));
  const w = workers[1],
    q = w.messages.find((x) => x.method === "query");
  assert.equal(q.args[0].src, "4910");
  w.onmessage({
    data: { requestId: q.requestId, ok: true, result: { total: 3 } },
  });
  assert.equal((await retry).total, 3);
  assert.equal(api.getState().status, "ready");
  // A terminated worker cannot affect the replacement.
  workers[0].onerror({});
  assert.equal(api.getState().status, "ready");
});
