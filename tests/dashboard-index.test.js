import './setup-env.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import { createDashboardModel } from "../src/dashboard-model.js";
import {
  packIndex,
  unpackIndex,
  createDashboardQueryEngine,
} from "../src/dashboard-index.js";
import {freshTracking} from './helpers/dashboard-fixture.js';
const model = createDashboardModel();
const items = Array.from({ length: 121 }, (_, n) =>
  model.summarize({
    n,
    tracking:freshTracking(n===0?0:n%7?8000+n:null,null),
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
  const a = await engine.query({includeHistory:true}, 1),
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
test('brand aliases survive compact indexes and older rows remain searchable',()=>{
 const item=model.summarize({src:'musinsa',n:2156295,b:'키뮤어',g:'캐시미어블렌드 코트',searchAliases:['kimuir','kimuir',null,''],L:[],pointEstimate:230830,pointDiscount:17370,pointState:"ELIGIBLE",pointCheckedAt:"2026-10-24T09:00:00Z",pointMaxUseRate:.07});
 const packed=packIndex([item],{revision:'r',id:'alias'}),restored=unpackIndex(packed)[0];
 assert.deepEqual(item.searchAliases,['kimuir']);
 assert.deepEqual(restored.searchAliases,['kimuir']);
 assert.equal(model.queryCatalog([restored],{q:'kimuir 캐시미어',includeHistory:true}).total,1);
 assert.equal(packed.rows[0][24][0],'kimuir');assert.deepEqual(packed.rows[0].slice(25,30),[230830,17370,'ELIGIBLE','2026-10-24T09:00:00Z',.07]);
 for(const length of [24,25]){
  const old=structuredClone(packed);old.rows=old.rows.map(row=>row.slice(0,length));
  const x=unpackIndex(old)[0];assert.deepEqual(x.searchAliases,length===24?[]:['kimuir']);
  for(const key of ['pointEstimate','pointDiscount','pointState','pointCheckedAt','pointMaxUseRate'])assert.equal(x[key],null);
  assert.equal(model.queryCatalog([x],{q:'코트 키뮤어',includeHistory:true}).total,1);
 }
 for(const searchAliases of [null,undefined,'kimuir',[]])assert.deepEqual(model.summarize({src:'4910',n:1,L:[],searchAliases}).searchAliases,[]);
});
