/** Identical transport for a Worker and file fallback. No DOM or module dependencies. */
export async function createDashboardTransport({
  manifest,
  index,
  scope,
  loadAsset,
  yieldTask = () => Promise.resolve(),
}) {
  function validate(ref, p, bytes) {
    if (
      p?.v !== 2 ||
      p.id !== ref.id ||
      p.revision !== manifest.revision ||
      bytes !== ref.bytes
    )
      throw Error("데이터 파일 버전/크기 불일치");
  }
  if (manifest.loadingMode === "scoped") return scoped();
  const chunks = new Array(manifest.indexParts.length);
  let next = 0;
  await Promise.all(
    Array.from(
      { length: Math.min(4, manifest.indexParts.length) },
      async () => {
        while (next < manifest.indexParts.length) {
          const i = next++,
            ref = manifest.indexParts[i],
            v = await loadAsset(ref);
          validate(ref, v.payload, v.bytes);
          chunks[i] = index.unpackIndex(v.payload);
          await yieldTask();
        }
      },
    ),
  );
  const rows = chunks.flat(),
    byKey = new Map(rows.map((x) => [x.k, x]));
  if (
    byKey.size !== rows.length ||
    (manifest.totalItems != null && rows.length !== manifest.totalItems)
  )
    throw Error("전체 상품 건수 불일치");
  const cache = new Map(),
    inflight = new Map();
  async function cardPart(ref) {
    if (cache.has(ref.id)) {
      const v = cache.get(ref.id);
      cache.delete(ref.id);
      cache.set(ref.id, v);
      return v;
    }
    if (inflight.has(ref.id)) return inflight.get(ref.id);
    const p = (async () => {
      const v = await loadAsset(ref);
      validate(ref, v.payload, v.bytes);
      const items = v.payload.items;
      if (!Array.isArray(items) || items.length !== ref.count)
        throw Error("카드 건수 불일치");
      const map = new Map(items.map((x) => [x.k, x]));
      cache.set(ref.id, map);
      while (cache.size > 8) cache.delete(cache.keys().next().value);
      return map;
    })();
    inflight.set(ref.id, p);
    try {
      return await p;
    } finally {
      inflight.delete(ref.id);
    }
  }
  const bootstrap = new Map(
    (manifest.bootstrap?.items || []).map((x) => [x.k, x]),
  );
  const engine = index.createDashboardQueryEngine({
    rows,
    loadCards: async (keys) => {
      const parts = new Map();
      for (const key of keys) {
        if (bootstrap.has(key)) continue;
        const ref = byKey.get(key)?.card;
        if (!ref) throw Error("카드 참조 없음");
        parts.set(ref.id, ref);
      }
      const loaded = new Map();
      const refs = [...parts.values()];
      let nextPart = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, refs.length) }, async () => {
          while (nextPart < refs.length) {
            const ref = refs[nextPart++];
            loaded.set(ref.id, await cardPart(ref));
          }
        }),
      );
      return keys.map((key) => {
        if (bootstrap.has(key)) return bootstrap.get(key);
        const x = loaded.get(byKey.get(key).card.id).get(key);
        if (!x) throw Error("카드 상품 없음");
        return x;
      });
    },
  });
  return engine;
  function scoped() {
    if (!scope) throw Error("Scope factory required");
    const loaded = new Map(),
      cards = new Map(),
      routes = new Map(),
      inflight = new Map(),
      queue = [];
    const preview = new Map(
      (manifest.previewItems || manifest.bootstrap?.items || []).map((x) => [
        x.k,
        x,
      ]),
    );
    let active = 0,
      generation = 0,
      current = null,
      cancelCurrent = null;
    const stale = () =>
      Object.assign(Error("검색 결과가 변경되었습니다"), {
        code: "STALE_RESULT",
      });
    function pump() {
      while (active < 4 && queue.length) {
        const job = queue.shift();
        active++;
        Promise.resolve()
          .then(() => loadAsset(job.ref))
          .then((v) => {
            validate(job.ref, v.payload, v.bytes);
            job.resolve(v.payload);
          }, job.reject)
          .catch(job.reject)
          .finally(() => {
            active--;
            inflight.delete(job.ref.id);
            pump();
          });
      }
    }
    function request(ref, kind, priority = Infinity) {
      if (inflight.has(ref.id)) {
        const job = inflight.get(ref.id);
        job.priority = Math.max(job.priority, priority);
        queue.sort((a, b) => b.priority - a.priority);
        return job.promise;
      }
      let resolve, reject;
      const promise = new Promise((a, b) => {
        resolve = a;
        reject = b;
      });
      const job = { ref, kind, promise, resolve, reject, priority };
      inflight.set(ref.id, job);
      queue.push(job);
      queue.sort((a, b) => b.priority - a.priority);
      pump();
      return promise;
    }
    async function indexPart(ref, priority) {
      if (loaded.has(ref.id)) return loaded.get(ref.id);
      const payload = await request(ref, "index", priority),
        rows = index.unpackIndex(payload);
      if (
        rows.length !== ref.count ||
        new Set(rows.map((x) => x.k)).size !== rows.length ||
        rows.some((x) => x.src !== ref.source || x.c !== ref.category)
      )
        throw Error("검색 범위/건수 불일치");
      loaded.set(ref.id, rows);
      await yieldTask();
      return rows;
    }
    async function cardPart(ref, priority) {
      if (cards.has(ref.id)) {
        const p = cards.get(ref.id);
        cards.delete(ref.id);
        cards.set(ref.id, p);
        return p;
      }
      const payload = await request(ref, "cards", priority);
      if (
        !Array.isArray(payload.items) ||
        payload.items.length !== ref.count ||
        new Set(payload.items.map((x) => x.k)).size !== ref.count
      )
        throw Error("카드 건수 불일치");
      const map = new Map(payload.items.map((x) => [x.k, x]));
      cards.set(ref.id, map);
      while (cards.size > 8) cards.delete(cards.keys().next().value);
      return map;
    }
    async function loadCards(keys, byKey, priority = Infinity) {
      const values = await Promise.all(
        keys.map(async (key) => {
          if (preview.has(key)) return preview.get(key);
          const ref = byKey.get(key)?.card;
          if (!ref) throw Error("카드 참조 없음");
          const x = (await cardPart(ref, priority)).get(key);
          if (!x) throw Error("카드 상품 없음");
          return x;
        }),
      );
      return values;
    }
    function requireCurrent(id) {
      if (!current || current.id !== id) throw stale();
      return current;
    }
    function mask(result, coverage) {
      for (const axis of ["sources", "categories"])
        for (const [key, complete] of Object.entries(coverage[axis]))
          result[axis][key] = complete ? (result[axis][key] ?? 0) : null;
      return result;
    }
    return {
      async cancelQuery() {
        generation++;
        current = null;
        cancelCurrent?.();
        cancelCurrent = null;
        for (let i = queue.length - 1; i >= 0; i--) {
          if (queue[i].kind !== "index") continue;
          const [job] = queue.splice(i, 1);
          inflight.delete(job.ref.id);
          job.reject(stale());
        }
      },
      async query(state, requestId) {
        const own = ++generation;
        current = null;
        cancelCurrent?.();
        const superseded = new Promise((resolve, reject) => {
          cancelCurrent = () => reject(stale());
        });
        const refs = scope.selectParts(manifest, state),
          needed = new Set(refs.map((x) => x.id));
        for (let i = queue.length - 1; i >= 0; i--)
          if (queue[i].kind === "index" && !needed.has(queue[i].ref.id)) {
            const [job] = queue.splice(i, 1);
            inflight.delete(job.ref.id);
            job.reject(stale());
          }
        try {
          await Promise.race([
            Promise.all(refs.map((ref) => indexPart(ref, own))),
            superseded,
          ]);
          if (own !== generation) throw stale();
          const rows = [...loaded.values()].flat(),
            byKey = new Map(rows.map((x) => [x.k, x]));
          if (byKey.size !== rows.length) throw Error("중복 상품 식별자");
          const engine = index.createDashboardQueryEngine({
            rows,
            loadCards: (keys) => loadCards(keys, byKey, own),
          });
          const coverage = scope.facetCoverage(
            manifest,
            new Set(loaded.keys()),
            state,
          );
          const result = await Promise.race([
            engine.query(state, requestId),
            superseded,
          ]);
          if (own !== generation) throw stale();
          current = { id: own, engine, internal: result.resultId, coverage };
          return { ...mask(result, coverage), resultId: own };
        } catch (error) {
          if (own !== generation) throw stale();
          throw error;
        }
      },
      async page(id, ...args) {
        const c = requireCurrent(id),
          r = await c.engine.page(c.internal, ...args);
        requireCurrent(id);
        return { ...mask(r, c.coverage), resultId: id };
      },
      async neighbor(id, ...args) {
        const c = requireCurrent(id),
          r = await c.engine.neighbor(c.internal, ...args);
        requireCurrent(id);
        return r;
      },
      async lookup(key) {
        if (preview.has(key)) return preview.get(key);
        const bucket = scope.routeBucket(key);
        if (!routes.has(bucket)) {
          const map = new Map();
          for (const ref of manifest.routes[bucket] || []) {
            const p = await request(ref, "routes");
            if (!Array.isArray(p.entries) || p.entries.length !== ref.count)
              throw Error("경로 건수 불일치");
            for (const [k, card] of p.entries) {
              if (scope.routeBucket(k) !== bucket || map.has(k))
                throw Error("경로 상품 불일치");
              map.set(k, { card });
            }
          }
          routes.set(bucket, map);
        }
        const row = routes.get(bucket).get(key);
        return row ? (await loadCards([key], new Map([[key, row]])))[0] : null;
      },
    };
  }
}
export function runDashboardWorker({ model, index, scope, transport }) {
  let enginePromise = null;
  const revisionAssets = new Map();
  async function loadAsset(ref) {
    if (!/^assets\/[a-z-]+-\d+\.js$/.test(ref.path))
      throw Error("잘못된 파일 경로");
    const response = await fetch(
      ref.path + "?v=" + encodeURIComponent(revisionAssets.get("revision")),
      { signal: AbortSignal.timeout(15000) },
    );
    if (!response.ok) throw Error("파일 요청 실패: " + response.status);
    const text = await response.text();
    (0, eval)(text);
    const payload = globalThis.__CLOT_ASSETS__?.[ref.id];
    delete globalThis.__CLOT_ASSETS__[ref.id];
    return { payload, bytes: new TextEncoder().encode(text).length };
  }
  onmessage = async ({ data }) => {
    const { requestId, method, args } = data;
    try {
      let result;
      if (method === "init") {
        const manifest = args[0];
        revisionAssets.set("revision", manifest.revision);
        enginePromise = transport({ manifest, index, scope, loadAsset });
        await enginePromise;
        result = true;
      } else {
        const engine = await enginePromise;
        if (
          !engine ||
          !["query", "page", "lookup", "neighbor", "cancelQuery"].includes(method)
        )
          throw Error("Unknown method");
        result = await engine[method](...args);
      }
      postMessage({ requestId, ok: true, result, error: null });
    } catch (error) {
      postMessage({
        requestId,
        ok: false,
        result: null,
        error: { code: error.code || "DATA_ERROR", message: error.message },
      });
    }
  };
}
