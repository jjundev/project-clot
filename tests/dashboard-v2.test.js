import './setup-env.js';
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeFixture } from "./helpers/dashboard-page.js";
import { verifyDashboardBuild } from "../scripts/verify-dashboard-build.js";
test("V2 build has exact bootstrap and no inline histories", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir, { wide: true });
  const file = path.join(dir, "index.html"),
    html = fs.readFileSync(file, "utf8"),
    D = JSON.parse(html.match(/window\.__CLOT_DATA__ = ([^\n]+);/)[1]);
  assert.equal(D.catalog.v, 2);
  assert.deepEqual(D.inlineHistories, {});
  assert.ok(D.items.length <= 120);
  assert.equal(D.catalog.bootstrap.total, D.catalog.totalItems);
  assert.equal(D.items.length, Math.min(120, D.catalog.totalItems));
  assert.equal(
    D.items.some((x) => "L" in x),
    false,
  );
  assert.equal(verifyDashboardBuild(file).totalItems, D.catalog.totalItems);
  const ref = D.catalog.indexParts[0],
    target = path.join(dir, ref.path),
    s = fs.readFileSync(target, "utf8");
  fs.writeFileSync(target, s.replace(D.catalog.revision, "wrong"));
  assert.throws(() => verifyDashboardBuild(file), /revision|asset/);
});
test("card byte split accounts for deferred history references", async (t) => {
  const { createDashboardBuilder } =
    await import("../src/dashboard-builder.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-size-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const b = createDashboardBuilder({ outDir: dir, revision: "r" });
  for (let n = 0; n < 1000; n++)
    b.add({
      src: "musinsa",
      n,
      g: "긴 상품명".repeat(20),
      b: "브랜드",
      L: [["2026-10-16", 200, 100, 90, 0, "가격", 10]],
    });
  const p = b.finish({ scanState: "complete" });
  assert.equal(p.catalog.totalItems, 1000);
  for (const file of fs.readdirSync(path.join(dir, "assets")))
    assert.ok(fs.statSync(path.join(dir, "assets", file)).size <= 262144);
});
test("one year of watched history never enters the initial HTML", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "v2-year-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  writeFixture(dir);
  const initial = fs.statSync(path.join(dir, "index.html")).size;
  writeFixture(dir, { historyDays: 365 });
  const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
  assert.ok(Buffer.byteLength(html) < initial + 15000);
  assert.equal(html.includes("이력".repeat(500)), false);
  for (const file of fs.readdirSync(path.join(dir, "assets")))
    assert.ok(fs.statSync(path.join(dir, "assets", file)).size <= 262144);
  assert.equal(
    verifyDashboardBuild(path.join(dir, "index.html")).totalItems,
    5,
  );
});
test('failed optional scan can roll back without losing wide or duplicating base',async t=>{
 const {createDashboardBuilder}=await import('../src/dashboard-builder.js');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-rollback-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));const b=createDashboardBuilder({outDir:dir,revision:'r'});b.add({src:'musinsa',n:1,L:[]});const point=b.checkpoint();b.add({src:'4910all',n:2,L:[]});b.rollback(point);b.add({src:'4910',n:3,L:[]});const p=b.finish({scanState:'partial',notice:'failed scan'});assert.equal(p.catalog.totalItems,2);assert.deepEqual(p.items.map(x=>x.k).sort(),['4910:3','musinsa:1']);
});
test('production base exporter never calls all on price history',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const {generateDashboardHtml}=await import('../src/visualizer.js');const db=new DatabaseSync(':memory:');db.exec("CREATE TABLE items(goods_no INTEGER,goods_name TEXT,brand_name TEXT,url TEXT,image_url TEXT,status TEXT,first_seen_at TEXT,last_checked_at TEXT);CREATE TABLE price_logs(id INTEGER,goods_no INTEGER,date TEXT,normal_price INTEGER,sale_price INTEGER,my_price INTEGER,is_sold_out INTEGER,coupon_name TEXT,coupon_discount INTEGER);INSERT INTO items VALUES(1,'상품','브랜드','','','ACTIVE','','');INSERT INTO price_logs VALUES(1,1,'2026-10-16',200,100,90,0,'쿠폰',10)");const wrapped={prepare(sql){const stmt=db.prepare(sql);if(/FROM price_logs/i.test(sql))return new Proxy(stmt,{get(target,prop){if(prop==='all')return ()=>{throw Error('UNBOUNDED_HISTORY_READ');};const v=target[prop];return typeof v==='function'?v.bind(target):v;}});return stmt;}};const dir=fs.mkdtempSync(path.join(os.tmpdir(),'v2-stream-'));try{const result=generateDashboardHtml({db:wrapped,db4910Path:null,dbMusinsaPath:null,outputPath:path.join(dir,'index.html'),openBrowser:false});assert.equal(result.totalItems,1);}finally{db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
