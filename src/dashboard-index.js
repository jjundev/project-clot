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
      const items = await loadCards(r.keys.slice(offset, offset + limit));
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
      async query(state, requestId) {
        const q = model.queryCatalog(rows, state),
          { items, ...facets } = q;
        const resultId = ++serial;
        current = { resultId, requestId, facets, keys: items.map((x) => x.k) };
        return page(resultId, 0);
      },
      page,
      async lookup(key) {
        if (!byKey.has(key)) return null;
        return (await loadCards([key]))[0] || null;
      },
      async neighbor(id, key, delta) {
        const r = requireResult(id),
          i = r.keys.indexOf(key);
        if (i < 0) return null;
        const target = r.keys[i + delta];
        if (!target) return null;
        const card = (await loadCards([target]))[0] || null;
        requireResult(id);
        return card ? { ...card, _position: i + delta } : null;
      },
    };
  }
  return { packIndex, unpackIndex, createDashboardQueryEngine };
}
const api = createDashboardIndex(createDashboardModel());
export const { packIndex, unpackIndex, createDashboardQueryEngine } = api;
