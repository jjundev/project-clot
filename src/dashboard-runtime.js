/** Async catalog transaction and separate history cache; serialized into static HTML. */
export function createDashboardRuntime(options) {
  const {
    model,
    baseItems,
    inlineHistories,
    manifest,
    loadScript,
    onChange = () => {},
  } = options;
  if (manifest.v === 2) return v2(options);
  function v2({manifest,model,indexFactory,scopeFactory,historyFactory,transportFactory,loadAsset,createWorker,onChange=()=>{}}) {
    indexFactory=indexFactory||globalThis.__CLOT_INDEX_FACTORY__;
    scopeFactory=scopeFactory||globalThis.__CLOT_SCOPE_FACTORY__;
    historyFactory=historyFactory||globalThis.__CLOT_HISTORY_FACTORY__;
    transportFactory=transportFactory||globalThis.__CLOT_TRANSPORT_FACTORY__;
    let state={status:'idle',phase:'preview',requestId:0,bootstrap:manifest.bootstrap,error:null,notice:manifest.notice};
    let pending=null,engine=null,worker=null,initialized=false,disposed=false,seq=0,querySeq=0,lastQuery=null;
    const calls=new Map(),local=new Set();
    const emit=()=>{if(!disposed)onChange(state);};
    const stale=()=>Object.assign(Error('검색 결과가 변경되었습니다'),{code:'STALE_RESULT'});
    function guarded(promise) {
      return new Promise((resolve,reject)=>{local.add(reject);Promise.resolve(promise).then(resolve,reject).finally(()=>local.delete(reject));});
    }
    function rpc(method,args) {
      const requestId=++seq;
      return new Promise((resolve,reject)=>{calls.set(requestId,{resolve,reject});try{worker.postMessage({requestId,method,args});}catch(e){calls.delete(requestId);reject(e);}});
    }
    function stop(error=Error('Worker stopped')) {
      initialized=false;engine=null;if(worker)worker.terminate();worker=null;
      for(const c of calls.values())c.reject(error);calls.clear();
      for(const reject of local)reject(error);local.clear();
    }
    function start() {
      if(disposed)return Promise.reject(Error('Runtime disposed'));
      if(pending)return pending;
      if(initialized)return Promise.resolve(state);
      state={...state,status:'loading',error:null};
      pending=Promise.resolve().then(async()=>{
        try {
          if(createWorker) {
            const w=worker=createWorker(manifest.workerPath);
            w.onmessage=({data})=>{if(disposed||worker!==w)return;const c=calls.get(data.requestId);if(!c)return;calls.delete(data.requestId);data.ok?c.resolve(data.result):c.reject(Object.assign(Error(data.error.message),{code:data.error.code}));};
            w.onerror=event=>{if(disposed||worker!==w)return;event.preventDefault?.();const error=Error('검색 Worker를 시작하지 못했습니다');stop(error);state={...state,status:'error',error:error.message};emit();};
            await rpc('init',[manifest]);
          }else engine=await guarded(transportFactory({manifest,index:indexFactory(model),scope:scopeFactory?.(),loadAsset,yieldTask:()=>new Promise(r=>setTimeout(r,0))}));
          if(disposed)throw Error('Runtime disposed');
          initialized=true;state={...state,status:state.phase==='query'?'loading':'ready',error:null};
        }catch(error){if(!disposed){stop(error);state={...state,status:'error',error:error.message};}}
        finally{pending=null;emit();}
        return state;
      });emit();return pending;
    }
    async function invoke(method,args) {
      await start();if(disposed)throw Error('Runtime disposed');if(!initialized)throw Error(state.error||'검색 준비 중');
      const result=await guarded(worker?rpc(method,args):engine[method](...args));if(disposed)throw Error('Runtime disposed');return result;
    }
    const history=historyFactory({revision:manifest.revision,loadAsset});
    const api={
      getState:()=>state,getCatalog:()=>state,start,ensureCatalog:start,
      async query(s) {
        const own=++querySeq;lastQuery=model.restoreState(s);state={...state,status:'loading',phase:'query',requestId:own,error:null};emit();
        try{const result=await invoke('query',[lastQuery,own]);if(own!==querySeq)throw stale();state={...state,status:'ready',error:null};emit();return result;}
        catch(error){if(disposed)throw Error('Runtime disposed');if(own!==querySeq)throw stale();if(error.code!=='STALE_RESULT'){state={...state,status:'error',error:error.message};emit();}throw error;}
      },
      retry(){if(lastQuery)return api.query(lastQuery);return start();},
      page:(...a)=>invoke('page',a),lookup:key=>invoke('lookup',[model.resolveKey(key)]),neighbor:(...a)=>invoke('neighbor',a),
      async getHistory(key,options) {const resolved=model.resolveKey(key),item=(manifest.previewItems||manifest.bootstrap.items).find(x=>x.k===resolved)||(await api.lookup(key));if(!item)throw Error('상품을 찾을 수 없습니다');return guarded(history.get(item.k,item.detail,options));},
      dispose(){disposed=true;querySeq++;stop(Error('Runtime disposed'));history.clear();}
    };api.retryCatalog=api.retry;return api;
  }
  let state = {
      status: manifest.parts.length ? "idle" : "ready",
      items: baseItems,
      scanState: manifest.scanState,
      notice: manifest.notice,
      error: null,
    },
    pending = null;
  const histories = new Map(),
    brands = new Map();
  const notify = () => onChange(state);
  function ensureCatalog() {
    if (pending) return pending;
    if (state.status === "ready") return Promise.resolve(state);
    state = { ...state, status: "loading", error: null };
    pending = Promise.resolve()
      .then(async () => {
        const ids = new Set(),
          paths = new Set();
        for (const ref of manifest.parts) {
          if (ids.has(ref.id) || paths.has(ref.path))
            throw Error("중복 요약 파일");
          ids.add(ref.id);
          paths.add(ref.path);
        }
        const loaded = new Array(manifest.parts.length);
        let next = 0,
          failed = null;
        const worker = async () => {
          try {
            while (!failed && next < manifest.parts.length) {
              const index = next++,
                ref = manifest.parts[index],
                part = await loadScript(ref.path);
              if (
                part?.v !== 1 ||
                part.revision !== manifest.revision ||
                part.id !== ref.id ||
                !Array.isArray(part.items) ||
                part.items.length !== ref.count
              )
                throw Error("요약 파일 불일치: " + ref.id);
              loaded[index] = part.items;
            }
          } catch (err) {
            failed = err;
            throw err;
          }
        };
        await Promise.allSettled(
          Array.from({ length: Math.min(4, manifest.parts.length) }, worker),
        );
        if (failed) throw failed;
        const scan = loaded.flat(),
          keys = new Set(baseItems.map((x) => x.k));
        if (scan.length !== manifest.scanCount)
          throw Error("전체 요약 건수 불일치");
        for (const x of scan) {
          if (
            !x ||
            !(
              (x.src === "4910" && x.kind === "scan") ||
              (x.src === "musinsa" && x.kind === "wide")
            ) ||
            x.k !== model.itemKey(x.src, x.n) ||
            keys.has(x.k) ||
            "L" in x
          )
            throw Error("요약 상품 식별 불일치");
          keys.add(x.k);
        }
        state = {
          ...state,
          status: "ready",
          items: model.mergeSummaries(baseItems, scan),
          error: null,
        };
      })
      .catch((err) => {
        state = {
          ...state,
          status: "error",
          items: baseItems,
          error: err.message,
        };
      })
      .finally(() => {
        pending = null;
        notify();
      });
    notify();
    return pending.then(() => state);
  }
  // Return the shared public promise, including its resolved state.
  function start() {
    if (pending) return pending;
    const result = ensureCatalog();
    if (state.status === "loading") pending = result;
    return result;
  }
  function retryCatalog() {
    if (pending) return pending;
    state = { ...state, status: "idle", error: null };
    return start();
  }
  async function getHistory(key) {
    key = model.resolveKey(key);
    if (Object.hasOwn(inlineHistories, key)) return inlineHistories[key];
    if (histories.has(key)) return histories.get(key);
    const item = state.items.find((x) => x.k === key);
    if (!item) throw Error("상품을 찾을 수 없습니다");
    const ref = item.detail;
    if (ref?.type === "musinsa") {
      let p = brands.get(ref.path);
      if (!p) {
        p = Promise.resolve()
          .then(() => loadScript(ref.path))
          .then((P) => {
            if (
              P?.v !== 1 ||
              P.revision !== manifest.revision ||
              P.id !== ref.id ||
              !P.histories
            )
              throw Error("이력 파일 불일치");
            return P;
          })
          .catch((err) => {
            brands.delete(ref.path);
            throw err;
          });
        brands.set(ref.path, p);
      }
      const P = await p,
        L = P.histories[key];
      if (!Array.isArray(L)) throw Error("상품 이력 없음");
      return L;
    }
    if (ref?.type !== "brand") throw Error("가격 이력 참조 없음");
    let p = brands.get(ref.path);
    if (!p) {
      p = Promise.resolve()
        .then(() => loadScript(ref.path))
        .then((P) => {
          if (
            P?.revision !== manifest.revision ||
            P.brandSno !== ref.brandSno ||
            !Array.isArray(P.r)
          )
            throw Error("이력 파일 불일치");
          return P;
        })
        .catch((err) => {
          brands.delete(ref.path);
          throw err;
        });
      brands.set(ref.path, p);
    }
    const result = p
      .then((P) => {
        const r = P.r.find((r) => model.itemKey("4910", r[0]) === key);
        if (!r) throw Error("상품 이력 없음");
        return r[7].map((h) => [
          h[0],
          h[1],
          h[2],
          h[3] ?? null,
          0,
          h[3] != null ? "4910 검증가" : "가격 재검증 필요",
          h[3] != null ? h[2] - h[3] : 0,
        ]);
      })
      .catch((err) => {
        histories.delete(key);
        throw err;
      });
    histories.set(key, result);
    return result;
  }
  return {
    getCatalog: () => state,
    ensureCatalog: start,
    retryCatalog,
    getHistory,
  };
}
