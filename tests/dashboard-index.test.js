import './setup-env.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardModel } from "../src/dashboard-model.js";
import {
  packIndex,
  unpackIndex,
  createDashboardQueryEngine,
} from "../src/dashboard-index.js";
const model = createDashboardModel();
const items = Array.from({ length: 121 }, (_, n) =>
  model.summarize({
    n,
    src: n % 2 ? "4910" : "musinsa",
    b: n % 3 ? "나이키" : "Adidas",
    g: "상품 " + n,
    c: n % 2 ? "top" : "bag",
    fs: "2026-10-16",
    i: "image",
    u: "url",
    L: [
      [
        "2026-10-16",
        10000,
        9000,
        n === 0 ? 0 : n % 7 ? 8000 + n : null,
        0,
        "가격",
        0,
      ],
    ],
  }),
);
test("compact index preserves canonical query semantics", async () => {
  const packed = packIndex(items, { revision: "r", id: "p" }),
    rows = unpackIndex(packed);
  assert.ok(JSON.stringify(packed).length < JSON.stringify(items).length);
  assert.ok(!JSON.stringify(packed).includes("image"));
  const engine = createDashboardQueryEngine({
    rows,
    loadCards: async (keys) => keys.map((k) => items.find((x) => x.k === k)),
  });
  for (const sort of [
    "category",
    "rate",
    "priceAsc",
    "priceDesc",
    "dropAmt",
    "brand",
    "new",
  ])
    for (const input of [
      {},
      { q: "나이키" },
      { src: "4910", cat: "top", brandKeys: ["나이키", "adidas"] },
      { filter: "out" },
      { q: "absent" },
    ]) {
      const state = { ...input, sort },
        expected = model.queryCatalog(items, state),
        actual = await engine.query(state, 1);
      for (const key of ["total", "sources", "quick", "categories", "brands"])
        assert.deepEqual(actual[key], expected[key]);
      assert.deepEqual(
        actual.items.map((x) => x.k),
        expected.items.slice(0, 120).map((x) => x.k),
      );
    }
});
test("page boundary and stale result", async () => {
  const engine = createDashboardQueryEngine({
    rows: unpackIndex(packIndex(items, { revision: "r", id: "p" })),
    loadCards: async (keys) => keys.map((k) => items.find((x) => x.k === k)),
  });
  const a = await engine.query({}, 1),
    last = await engine.page(a.resultId, 120);
  assert.equal(a.items.length, 120);
  assert.equal(last.items.length, 1);
  assert.equal(
    (await engine.neighbor(a.resultId, a.items[119].k, 1)).k,
    last.items[0].k,
  );
  assert.equal((await engine.lookup(last.items[0].k)).k, last.items[0].k);
  await engine.query({ q: "other" }, 2);
  await assert.rejects(engine.page(a.resultId, 0), { code: "STALE_RESULT" });
});
