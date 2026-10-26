/** Shared build/Worker/file scope rules. Keep free of module references. */
export function createDashboardScope() {
  const categories = ["all", "top", "outer", "bottom", "shoes", "bag", "etc"];
  // History rows cannot be fresh at or after asOfMs, so only a clock behind the build needs them by default.
  function selectParts(manifest, state = {}, { nowMs = Date.now() } = {}) {
    const history = state.includeHistory || nowMs < manifest.asOfMs;
    return manifest.indexParts.filter(
      (r) =>
        (!state.src || state.src === "all" || r.source === state.src) &&
        (!state.cat || state.cat === "all" || r.category === state.cat) &&
        (history || r.tier !== "history"),
    );
  }
  function facetCoverage(manifest, loadedIds, state, { nowMs = Date.now() } = {}) {
    const covered = (s) =>
      selectParts(manifest, s, { nowMs }).every((r) => loadedIds.has(r.id));
    return {
      sources: Object.fromEntries(
        ["all", "musinsa", "4910"].map((src) => [
          src,
          covered({ ...state, src }),
        ]),
      ),
      categories: Object.fromEntries(
        categories.map((cat) => [cat, covered({ ...state, cat })]),
      ),
    };
  }
  function routeBucket(key) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i++)
      h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    return h & 255;
  }
  return { selectParts, facetCoverage, routeBucket };
}
