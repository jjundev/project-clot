import { classifyCategory } from "./classifier.js";
import {trackingFromLogs} from './price-observation.js';
import {
  effective4910Price,
  readPriceValidations,
} from "./site4910/price-validation.js";
/** Production-only base export. Legacy payload helpers remain available to callers. */
export function exportDashboardBase(
  db,
  { sink, db4910 = null, skipMusinsa = new Set(), targetGoodsNo } = {},
) {
  db=db?.db||db;
  const cols = new Set(
    db
      .prepare("PRAGMA table_info(price_logs)")
      .all()
      .map((x) => x.name),
  );
  const cat = db
    .prepare("PRAGMA table_info(items)")
    .all()
    .some((x) => x.name === "category");
  const logs = db.prepare(
    `SELECT date,normal_price,sale_price,my_price,${cols.has("estimated_my_price") ? "estimated_my_price" : "NULL AS estimated_my_price"},is_sold_out,coupon_name,coupon_discount,${cols.has('created_at')?'created_at':'NULL AS created_at'},${cols.has('my_observed_at')?'my_observed_at':'NULL AS my_observed_at'},${cols.has('estimated_observed_at')?'estimated_observed_at':'NULL AS estimated_observed_at'} FROM price_logs WHERE goods_no=? ORDER BY date,id`,
  );
  let maxChecked = "",
    lastRun = null;
  const dates = [];
  let total4910Base = 0;
  for (const g of db
    .prepare(
      "SELECT * FROM items ORDER BY goods_no",
    )
    .iterate()) {
    if (g.last_checked_at > maxChecked) maxChecked = g.last_checked_at;
    const explicit=['like','manual'].includes(g.source)&&['ACTIVE','SOLDOUT'].includes(g.status);
    if (skipMusinsa.has(g.goods_no)&&!explicit) continue;
    const L = [];
    const observations=[...logs.iterate(g.goods_no)];
    for (const r of observations)
      L.push([
        r.date,
        r.normal_price ?? null,
        r.sale_price ?? null,
        r.my_price ?? r.estimated_my_price ?? null,
        r.is_sold_out ? 1 : 0,
        r.coupon_name ||
          (r.coupon_discount > 0 ? "쿠폰 적용가" : "나의 할인가"),
        r.coupon_discount || 0,
      ]);
    sink.add({
      n: Number(g.goods_no),
      kind:explicit?'musinsa':'archive',
      priceBasis:observations.at(-1)?.my_price!=null?'MUSINSA_MY':'MUSINSA_ESTIMATED',
      tracking:trackingFromLogs(observations.map(r=>({...r,created_at:(r.my_price!=null?r.my_observed_at:r.estimated_observed_at)||r.created_at})),{status:explicit?'ACTIVE':'STOPPED',priceOf:r=>r.my_price??r.estimated_my_price,basisOf:r=>r.my_price!=null?'MUSINSA_MY':'MUSINSA_ESTIMATED'}),
      src: "musinsa",
      b: g.brand_name || "-",
      g: g.goods_name || "상품",
      u: g.url || "https://www.musinsa.com/products/" + g.goods_no,
      i: g.image_url || "",
      s: g.status || "ACTIVE",
      c: (cat && g.category) || classifyCategory(g.goods_name, g.brand_name),
      fs: g.first_seen_at?.slice(0, 10) || "",
      L,
    });
    if (L.length) dates.push(L[0][0], L.at(-1)[0]);
  }
  if (
    db4910 &&
    db4910
      .prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name IN ('liked_goods','liked_price_logs')",
      )
      .get().n === 2
  ) {
    const scanStatus=db4910.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='goods'").get()?db4910.prepare('SELECT status FROM goods WHERE sno=?'):null;
    const stmt = db4910.prepare(
      "SELECT date,list_price,original_price,coupon_price,member_price,is_soldout FROM liked_price_logs WHERE sno=? ORDER BY date,id",
    );
    for (const g of db4910
      .prepare("SELECT * FROM liked_goods ORDER BY sno")
      .iterate()) {
      if(g.status!=='ACTIVE'&&scanStatus?.get(g.sno)?.status==='ACTIVE')continue;
      const validations = readPriceValidations(db4910, "liked", { sno: g.sno }),
        L = [], confirmed=[];
      for (const r of stmt.iterate(g.sno)) {
        const v = validations.get(g.sno + ":" + r.date),
          my = effective4910Price({ raw: r, validation: v }),
          e = v?.evidence_json ? JSON.parse(v.evidence_json) : null,
          c = v?.corrected_json ? JSON.parse(v.corrected_json) : null,
          proven = e?.priceBasis === "AGLO" && e.observedDate === r.date,
          base = proven
            ? e.basePrice
            : v?.status === "verified"
              ? r.list_price
              : c?.list_price,
          normal = proven
            ? e.originalPrice
            : v?.status === "verified"
              ? r.original_price
              : c?.original_price;
        L.push([
          r.date,
          normal ?? null,
          base ?? null,
          my,
          r.is_soldout ? 1 : 0,
          my == null ? "가격 재검증 필요" : "4910 검증가",
          base != null && my != null ? Math.max(base - my, 0) : 0,
          null,
        ]);
        if(my!=null)confirmed.push({...r,checked_at:v?.checked_at,price:my});
      }
      const v = validations.get(g.sno + ":" + L.at(-1)?.[0]);
      sink.add({
        n: Number(g.sno),
        tracking:trackingFromLogs(confirmed,{status:g.status==='ACTIVE'?'ACTIVE':'STOPPED',priceOf:r=>r.price,basisOf:()=> '4910 검증가'}),
        src: "4910",
        vd: v?.checked_at ?? null,
        vs: v?.status ?? "unverified",
        b: g.brand || g.market_name || "4910",
        m: g.market_name,
        g: g.name || "상품",
        u: g.url,
        i: g.image_url || "",
        s: "ACTIVE",
        c: classifyCategory(g.name, g.brand),
        fs: g.first_liked_date || "",
        L,
      });
      total4910Base++;
      if (L.length) dates.push(L[0][0], L.at(-1)[0]);
    }
  }
  let runs = [];
  try {
    const run = db
      .prepare(
        "SELECT date,total_tracked,price_dropped_count,restocked_count,duration_ms,completed_at FROM daily_runs ORDER BY date DESC,completed_at DESC LIMIT 1",
      )
      .get();
    if (run) {
      lastRun = run.completed_at;
      runs = [run];
    }
  } catch {}
  dates.sort();
  return {
    sample: false,
    generatedAt: new Date().toISOString(),
    lastRun: lastRun || maxChecked || null,
    targetGoodsNo: targetGoodsNo ? Number(targetGoodsNo) : undefined,
    dates: dates.length ? [dates[0], dates.at(-1)] : [],
    runs,
    items: [],
    total4910Base,
  };
}
