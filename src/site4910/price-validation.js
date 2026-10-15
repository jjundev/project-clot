// Only explicit evidence authorizes use in comparisons. Legacy coupon prices stay visible as raw DB evidence only.
export function effective4910Price({ raw, validation }) {
  if (!validation || !['verified', 'corrected'].includes(validation.status)) return null;
  let corrected = validation.corrected ?? null;
  try { if (validation.corrected_json) corrected = JSON.parse(validation.corrected_json); } catch { return null; }
  if (validation.status === 'corrected' && !corrected) return null;
  const row = corrected ?? raw;
  const price = Object.hasOwn(row, 'member_price') ? row.member_price : row.coupon_price;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function readPriceValidations(db, kind) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_validations'").get()) return new Map();
  return new Map(db.prepare('SELECT * FROM price_validations WHERE kind=?').all(kind).map(r => [`${r.sno}:${r.date}`, r]));
}
