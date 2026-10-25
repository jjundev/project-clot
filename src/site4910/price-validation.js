// Only explicit evidence authorizes use in comparisons. Legacy coupon prices stay visible as raw DB evidence only.
export function effective4910Price({ raw, validation }) {
  if (!validation || !["verified", "corrected"].includes(validation.status))
    return null;
  let corrected = validation.corrected ?? null;
  try {
    if (validation.corrected_json)
      corrected = JSON.parse(validation.corrected_json);
  } catch {
    return null;
  }
  if (validation.status === "corrected" && !corrected) return null;
  const row = corrected ?? raw;
  const price = Object.hasOwn(row, "member_price")
    ? row.member_price
    : row.coupon_price;
  return Number.isFinite(price) && price >= 0 ? price : null;
}

export function readPriceValidations(
  db,
  kind,
  {
    brandSno = null, sno = null, snoFrom = null, snoTo = null,
    snos = null, includeEvidence = true,
  } = {},
) {
  if ((snoFrom == null) !== (snoTo == null) ||
      (snoFrom != null && snoFrom > snoTo))
    throw new RangeError("Both bounds of an ordered sno range are required");
  if (snos !== null && (!Array.isArray(snos) ||
      snos.some(id => !Number.isSafeInteger(id) || id <= 0)))
    throw new TypeError("snos must be an array of positive safe integers");

  const result = new Map();
  if (snos?.length === 0) return result;
  if (!db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='price_validations'",
  ).get()) return result;

  const conditions = ["kind=?"];
  const params = [kind];
  if (brandSno != null) {
    conditions.push("sno IN (SELECT sno FROM goods WHERE brand_sno=?)");
    params.push(Number(brandSno));
  }
  if (sno != null) {
    conditions.push("sno=?");
    params.push(sno);
  }
  if (snoFrom != null) {
    conditions.push("sno>=? AND sno<=?");
    params.push(snoFrom, snoTo);
  }
  const columns = includeEvidence
    ? "*"
    : "kind,sno,date,status,corrected_json,reason,checked_at";
  const sql = `SELECT ${columns} FROM price_validations WHERE ${conditions.join(" AND ")}`;
  const read = (query, bindings) => {
    for (const row of db.prepare(query).iterate(...bindings))
      result.set(`${row.sno}:${row.date}`, row);
  };
  if (snos === null) {
    read(sql, params);
  } else {
    const ids = [...new Set(snos)];
    for (let offset = 0; offset < ids.length; offset += 200) {
      const batch = ids.slice(offset, offset + 200);
      read(`${sql} AND sno IN (${batch.map(() => "?").join(",")})`, [...params, ...batch]);
    }
  }
  return result;
}
