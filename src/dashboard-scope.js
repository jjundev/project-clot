/** Shared build/Worker/file scope rules. Keep free of module references. */
export function createDashboardScope() {
 const categories=['all','top','outer','bottom','shoes','bag','etc'];
 function selectParts(manifest,state={}) {
  return manifest.indexParts.filter(r=>(!state.src||state.src==='all'||r.source===state.src)&&(!state.cat||state.cat==='all'||r.category===state.cat));
 }
 function facetCoverage(manifest,loadedIds,state) {
  const covered=s=>selectParts(manifest,s).every(r=>loadedIds.has(r.id));
  return {sources:Object.fromEntries(['all','musinsa','4910'].map(src=>[src,covered({...state,src})])),categories:Object.fromEntries(categories.map(cat=>[cat,covered({...state,cat})]))};
 }
 function routeBucket(key) {let h=2166136261;for(let i=0;i<key.length;i++)h=Math.imul(h^key.charCodeAt(i),16777619);return h&255;}
 return {selectParts,facetCoverage,routeBucket};
}
