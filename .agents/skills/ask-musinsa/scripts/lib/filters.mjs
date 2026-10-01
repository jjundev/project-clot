/**
 * Musinsa filter normalization engine for label sizes, shoe sizes, and garment measurements.
 */
const STANDARD_SIZE_MAP = {
  xs: 'XS',
  s: 'S',
  m: 'M',
  l: 'L',
  xl: 'XL',
  xxl: 'XXL',
  '2xl': 'XXL',
  '3xl': 'XXL',
};

const MEASUREMENT_ALIASES = {
  총장: '총장',
  기장: '총장',
  길이: '총장',
  옷길이: '총장',
  가슴: '가슴단면',
  가슴단면: '가슴단면',
  가슴너비: '가슴단면',
  허리: '허리단면',
  허리단면: '허리단면',
  허리너비: '허리단면',
  허벅지: '허벅지단면',
  허벅지단면: '허벅지단면',
  밑단: '밑단단면',
  밑단단면: '밑단단면',
  소매: '소매길이',
  소매길이: '소매길이',
  팔: '소매길이',
  팔길이: '소매길이',
  어깨: '어깨너비',
  어깨너비: '어깨너비',
  어깨길이: '어깨너비',
  밑위: '밑위',
  밑위길이: '밑위',
  엉덩이: '엉덩이단면',
  엉덩이단면: '엉덩이단면',
  힙: '엉덩이단면',
  소매부리: '소매부리단면',
  소매부리단면: '소매부리단면',
};

/**
 * Normalizes user-entered clothing sizes to Musinsa standard codes.
 * @param {string} input - e.g. "M", "L, XL", "2XL"
 * @returns {string|null} - e.g. "M,L,XL", "XXL"
 */
export function normalizeStandardSize(input) {
  if (!input) return null;
  const parts = String(input)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const matched = [];
  for (const part of parts) {
    const mapped = Object.hasOwn(STANDARD_SIZE_MAP, part) ? STANDARD_SIZE_MAP[part] : null;
    if (mapped) {
      matched.push(mapped);
    }
  }

  return matched.length > 0 ? Array.from(new Set(matched)).join(',') : null;
}

/**
 * Normalizes shoe size in millimeters.
 * @param {string|number} input - e.g. "270", "270mm", "265, 270"
 * @returns {string|null} - e.g. "270" or "265,270"
 */
export function normalizeShoeSize(input) {
  if (!input) return null;
  const parts = String(input)
    .split(',')
    .map((s) => s.replace(/mm/gi, '').trim())
    .filter((s) => /^\d{3}$/.test(s));

  return parts.length > 0 ? Array.from(new Set(parts)).join(',') : null;
}

/**
 * Parses conversational garment measurement string into Musinsa caret format.
 * Syntax supported:
 *   "총장:70-75,가슴:55-60"
 *   "기장:70~75"
 *   "기장:75+" (min 75, max 150)
 *   "기장:~75" (min 0, max 75)
 * @param {string} input
 * @returns {string|null} - e.g. "총장^70^75,가슴단면^55^60"
 */
export function parseMeasurementInput(input) {
  if (!input) return null;
  const items = String(input)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  const formattedParts = [];

  for (const item of items) {
    // Match patterns like "기장:70-75", "총장=70~75", "가슴:75+", "허리:~40"
    const match = item.match(/^([^:=~+\-\d\s]+)\s*[:=]\s*(.+)$/);
    if (!match) continue;

    const rawKey = match[1].trim();
    const rawVal = match[2].trim();
    const resolvedKey = Object.hasOwn(MEASUREMENT_ALIASES, rawKey) ? MEASUREMENT_ALIASES[rawKey] : null;
    if (!resolvedKey) continue;

    let min = 0;
    let max = 150;

    // Pattern 1: Min only with + or ~ (e.g. 75+, 75~)
    const minOnlyMatch = rawVal.match(/^(\d+(?:\.\d+)?)\s*(?:\+|~)$/);
    if (minOnlyMatch) {
      min = Math.round(Number(minOnlyMatch[1]));
      max = 150;
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }

    // Pattern 2: Max only with ~ or - prefix (e.g. ~75, -75)
    const maxOnlyMatch = rawVal.match(/^[~\-]\s*(\d+(?:\.\d+)?)$/);
    if (maxOnlyMatch) {
      min = 0;
      max = Math.round(Number(maxOnlyMatch[1]));
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }

    // Pattern 3: Range (e.g. 70-75, 70~75, 70 75)
    const rangeMatch = rawVal.match(/^(\d+(?:\.\d+)?)\s*[\-~_\s]\s*(\d+(?:\.\d+)?)$/);
    if (rangeMatch) {
      min = Math.round(Number(rangeMatch[1]));
      max = Math.round(Number(rangeMatch[2]));
      if (min > max) [min, max] = [max, min];
      formattedParts.push(`${resolvedKey}^${min}^${max}`);
      continue;
    }
  }

  return formattedParts.length > 0 ? formattedParts.join(',') : null;
}

/**
 * Builds query parameters from CLI options with smart routing.
 * @param {object} options
 * @returns {{ standardSize?: string, shoeSizeOption?: string, measurement?: string }}
 */
export function buildFilterQueryParams(options = {}) {
  const params = {};

  const sizeInput = options.size;
  const shoeSizeInput = options['shoe-size'] || options.shoeSize;
  const measureInput = options.measure || options.measurement;

  // Explicit shoe size
  if (shoeSizeInput) {
    const shoeSize = normalizeShoeSize(shoeSizeInput);
    if (shoeSize) params.shoeSizeOption = shoeSize;
  }

  // Handle size input: smart detection (if all numbers, treat as shoe size)
  if (sizeInput) {
    const trimmed = String(sizeInput).trim();
    if (/^\d{3}(?:\s*,\s*\d{3})*$/.test(trimmed)) {
      const shoeSize = normalizeShoeSize(trimmed);
      if (shoeSize) params.shoeSizeOption = shoeSize;
    } else {
      const standardSize = normalizeStandardSize(trimmed);
      if (standardSize) params.standardSize = standardSize;
    }
  }

  // Handle measurement input
  if (measureInput) {
    const measurement = parseMeasurementInput(measureInput);
    if (measurement) params.measurement = measurement;
  }

  return params;
}
