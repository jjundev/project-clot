import { createDashboardModel } from "./dashboard-model.js";
/** Wire positions are versioned here; display-only URLs/history never enter this index. */
export function createDashboardIndex(model) {
  const fields = [
    "k",
    "src",
    "kind",
    "n",
    "b",
    "m",
    "g",
    "c",
    "fs",
    "my",
    "sale",
    "normal",
    "newbie",
    "rate",
    "dropAmt",
    "isOut",
    "isLow",
    "lowEligible",
    "lowMy",
    "lowDate",
    "tracked",
    "priceSource",
    "observedDate",
    "card",
    "searchAliases",
    "pointEstimate", "pointDiscount", "pointState", "pointCheckedAt", "pointMaxUseRate",
    "tracking", "priceBasis", "lowCandidate", "dropEligible",
  ];
  function packIndex(items, { revision, id }) {
    const dictionaries = {};
    for (const f of ["src", "kind", "b", "m", "c", "priceSource", "card"])
      dictionaries[f] = [...new Set(items.map((x) => x[f] ?? null))];
    const maps = Object.fromEntries(
      Object.entries(dictionaries).map(([f, a]) => [
        f,
        new Map(a.map((x, i) => [x, i])),
      ]),
    );
    return {
      v: 2,
      revision,
      id,
      dictionaries,
      rows: items.map((x) =>
        fields.map((f) =>
          maps[f] ? maps[f].get(x[f] ?? null) : (x[f] ?? null),
        ),
      ),
    };
  }
  function unpackIndex(part) {
    if (part.v !== 2 || !Array.isArray(part.rows))
      throw Error("Invalid dashboard index");
    return part.rows.map((a) => {
      const x = {};
      fields.forEach((f, i) => {
        x[f] = part.dictionaries[f] ? part.dictionaries[f][a[i]] : a[i];
      });
      x.searchAliases = Array.isArray(x.searchAliases) ? x.searchAliases.filter(v => typeof v === "string" && v.trim()) : [];
      for (const f of ["pointEstimate","pointDiscount","pointState","pointCheckedAt","pointMaxUseRate"]) x[f] = x[f] ?? null;
      x._searchFields = model.searchFields(x);
      x.brandKey = model.brandKey(x.b);
      x._hay = model.brandKey([x.b, x.m, x.g, x.n].join(" "));
      return x;
    });
  }
  function createDashboardQueryEngine({ rows, loadCards }) {
    let serial = 0,
      current = null;
    const byKey = new Map(rows.map((x) => [x.k, x]));
    function requireResult(id) {
      if (!current || current.resultId !== id)
        throw Object.assign(Error("검색 결과가 변경되었습니다"), {
          code: "STALE_RESULT",
        });
      return current;
    }
    async function page(id, offset = 0, limit = 120) {
      const r = requireResult(id);
      offset = Math.max(0, offset);
      limit = Math.max(0, Math.min(120, limit));
      const items = (await loadCards(r.keys.slice(offset, offset + limit))).map(x=>model.refresh(x,{asOfMs:r.asOfMs}));
      requireResult(id);
      return {
        ...r.facets,
        requestId: r.requestId,
        resultId: id,
        items,
        offset,
        nextOffset:
          offset + items.length < r.keys.length ? offset + items.length : null,
      };
    }
    return {
      async query(state, requestId, asOfMs=Date.now()) {
        const q = model.queryCatalog(rows, state,{asOfMs}),
          { items, ...facets } = q;
        const resultId = ++serial;
        current = { resultId, requestId, asOfMs, facets, keys: items.map((x) => x.k) };
        return page(resultId, 0);
      },
      page,
      async lookup(key,asOfMs=Date.now()) {
        if (!byKey.has(key)) return null;
        const item=(await loadCards([key]))[0];return item?model.refresh(item,{asOfMs}):null;
      },
      async neighbor(id, key, delta) {
        const r = requireResult(id),
          i = r.keys.indexOf(key);
        if (i < 0) return null;
        const target = r.keys[i + delta];
        if (!target) return null;
        const card = (await loadCards([target]))[0] || null;
        requireResult(id);
        return card ? { ...model.refresh(card), _position: i + delta } : null;
      },
    };
  }
  return { packIndex, unpackIndex, createDashboardQueryEngine, refresh: model.refresh };
}
const api = createDashboardIndex(createDashboardModel());
export const { packIndex, unpackIndex, createDashboardQueryEngine } = api;
