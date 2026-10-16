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
test('transport reuses bootstrap cards and fetches other card files with bounded concurrency',async()=>{
 const model=createDashboardModel(),index=createDashboardIndex(model),items=Array.from({length:8},(_,n)=>({...model.summarize({src:'musinsa',n,b:'브랜드',g:'상품'+n,L:[]}),card:{id:'cards-'+n,path:'assets/cards-'+n+'.js',count:1,bytes:1}}));let cardCalls=0,active=0,max=0;const manifest={v:2,revision:'r',totalItems:8,indexParts:[{id:'index-0',path:'assets/index-0.js',bytes:1,count:8}],bootstrap:{items}};
 const loadAsset=async ref=>{if(ref.id==='index-0')return {payload:packIndex(items,{revision:'r',id:ref.id}),bytes:1};cardCalls++;max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));active--;return {payload:{v:2,revision:'r',id:ref.id,items:[items.find(x=>x.card.id===ref.id)]},bytes:1};};
 const seeded=await createDashboardTransport({manifest,index,loadAsset});assert.equal((await seeded.query({})).total,8);assert.equal(cardCalls,0);
 const fresh=await createDashboardTransport({manifest:{...manifest,bootstrap:{items:[]}},index,loadAsset});await fresh.query({});assert.ok(max>1&&max<=4);
});
