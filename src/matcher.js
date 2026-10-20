/**
 * Deterministic fuzzy matcher for customer names and catalog item names.
 * No external dependencies.
 */

export const THRESHOLDS = {
  MIN_SCORE: 0.6,
  CONFIDENT_SCORE: 0.8,
  MARGIN: 0.15,
};

// Standard corporate / legal / branch suffixes that are naturally generic across any B2B domain
const UNIVERSAL_GENERIC_WORDS = new Set([
  'enterprises', 'enterprise', 'traders', 'trader', 'trading',
  'corporation', 'corp', 'limited', 'ltd', 'pvt', 'private',
  'company', 'co', 'industries', 'industry', 'supplies', 'supply',
  'distributors', 'distributor', 'services', 'service', 'solutions',
  'mart', 'hub', 'centre', 'center', 'central', 'store', 'stores',
  'agency', 'agencies', 'group', 'associates', 'main', 'branch',
  'international', 'intl',
]);

/**
 * Dynamically extract high-frequency filler words from any catalogue.
 * For example, if a client has 50 items and 40 of them contain the word "cement" or "tablet" or "wheel",
 * that word has low discriminating power when matching specific items and shouldn't penalize reps if omitted.
 *
 * @param {Array<{ name: string }>} items - Catalog item or contact records
 * @param {number} [thresholdRatio=0.3] - Fraction of records a token must appear in to be considered generic
 * @returns {Set<string>}
 */
export function deriveGenericTokens(items = [], thresholdRatio = 0.3) {
  const generic = new Set(UNIVERSAL_GENERIC_WORDS);
  if (!Array.isArray(items) || items.length === 0) return generic;

  // Common packaging, measurement units, prepositions, and domain filler words that frequently appear in product names
  const commonUnitStopwords = new Set([
    'tablet', 'tablets', 'capsule', 'capsules', 'strip', 'strips', 'bottle', 'bottles',
    'packet', 'packets', 'pack', 'packs', 'box', 'boxes', 'bag', 'bags', 'drum', 'drums',
    'standard', 'piece', 'pieces', 'set', 'sets', 'wheel', 'wheels', 'alloy', 'alloys',
    'mg', 'ml', 'mcg', 'gm', 'kg', 'mm', 'cm', 'mtr', 'mtrs', 'ton', 'tons', 'pcs', 'pc', 'nos', 'ltr', 'ltrs',
    'of', 'for', 'with', 'and', 'in'
  ]);

  const docCount = new Map();
  for (const item of items) {
    if (!item || !item.name) continue;
    const tokens = new Set(normalizeText(item.name).split(' ').filter(Boolean));
    for (const t of tokens) {
      if (/^\d+$/.test(t)) continue; // Never treat dimensions/numbers as generic
      docCount.set(t, (docCount.get(t) || 0) + 1);
    }
  }

  // To be treated as an auto-derived filler word, the token must be in the common unit stopwords list
  // OR appear across a significant portion of items (at least 2 items AND >= thresholdRatio of the catalog)
  const minDocFreq = Math.max(2, Math.floor(items.length * thresholdRatio));
  for (const [token, count] of docCount.entries()) {
    if (commonUnitStopwords.has(token) || (count >= minDocFreq && token.length > 3)) {
      generic.add(token);
    }
  }

  return generic;
}

// Standardize text: lowercase, strip punctuation, normalize spaces and universal contractions
export function normalizeText(str, customReplacements = {}) {
  if (!str) return '';
  let s = str
    .toLowerCase()
    .replace(/\\/g, ' ')
    // Separate numbers from attached metric units: 650mg -> 650 mg, 100ml -> 100 ml, 12mm -> 12 mm, 50kg -> 50 kg
    .replace(/\b(\d+)\s*(mg|ml|mcg|gm|kg|mm|cm|mtr|mtrs|ton|tons|pcs|pc|nos|ltr|ltrs|strip|strips|tab|tabs|cap|caps)\b/g, '$1 $2')
    // Normalize dimension/unit symbols e.g. 18", 18in, 18-inch -> 18
    .replace(/\b(\d+)\s*(inch|in|-inch)\b/g, '$1')
    .replace(/["']/g, '')
    // Universal color / descriptor abbreviations
    .replace(/\bblk\b/g, 'black')
    .replace(/\b(slv|slvr)\b/g, 'silver')
    .replace(/\b(wht|wte)\b/g, 'white')
    .replace(/\b(blu)\b/g, 'blue')
    .replace(/\b(grn)\b/g, 'green')
    .replace(/\b(rd)\b/g, 'red')
    // Common shorthand
    .replace(/\bwhls?\b/g, 'wheels')
    .replace(/\bmotrs\b/g, 'motors')
    .replace(/\bauto\s*spares\b/g, 'auto spares');

  // Apply any client-specific custom replacements
  if (customReplacements && typeof customReplacements === 'object') {
    for (const [pattern, repl] of Object.entries(customReplacements)) {
      s = s.replace(new RegExp(`\\b${pattern}\\b`, 'gi'), repl);
    }
  }

  return s
    .replace(/[\-,\/#!$%\^&\*;:{}=\_`~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Levenshtein distance between two strings
 */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;

  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    const ca = a.charCodeAt(i - 1);
    for (let j = 1; j <= n; j++) {
      const cb = b.charCodeAt(j - 1);
      const cost = ca === cb ? 0 : 1;
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + cost
      );
    }
  }
  return dp[m][n];
}

/**
 * Normalized string similarity in [0, 1]
 */
function stringSimilarity(a, b) {
  if (a === b) return 1.0;
  // If either token is numeric (like wheel sizes 15, 16, 17, 18), require exact equality
  if (/^\d+$/.test(a) || /^\d+$/.test(b)) {
    return a === b ? 1.0 : 0.0;
  }
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return 1.0;
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Token-based similarity supporting word reordering, token sets, and typos
 *
 * @param {string} query
 * @param {string} target
 * @param {Object} [options]
 * @param {Set<string>} [options.genericWords]
 * @param {Object} [options.customReplacements]
 */
export function computeSimilarity(query, target, options = {}) {
  const qNorm = normalizeText(query, options.customReplacements);
  const tNorm = normalizeText(target, options.customReplacements);

  if (qNorm === tNorm) return 1.0;
  if (!qNorm || !tNorm) return 0.0;

  const qTokens = qNorm.split(' ').filter(Boolean);
  const tTokens = tNorm.split(' ').filter(Boolean);

  if (qTokens.length === 0 || tTokens.length === 0) return 0.0;

  // Check numeric tokens: if query has a numeric dimension/code (e.g. 17, 650, 500),
  // target MUST contain it
  const qNums = qTokens.filter((t) => /^\d+$/.test(t));
  const tNums = tTokens.filter((t) => /^\d+$/.test(t));
  for (const qn of qNums) {
    if (tNums.length > 0 && !tNums.includes(qn)) {
      // Dimension/code mismatch
      return 0.0;
    }
  }

  // Exact substring check when strings are short names (e.g. "Gupta Auto" in "Gupta Auto Spares")
  if (tNorm === qNorm) return 1.0;

  // Token recall: how well query tokens are covered in target
  let qMatchedSum = 0;
  for (const qTok of qTokens) {
    let best = 0;
    for (const tTok of tTokens) {
      if (qTok === tTok) { best = 1.0; break; }
      const sim = stringSimilarity(qTok, tTok);
      if (sim > best) best = sim;
    }
    qMatchedSum += best;
  }
  const recall = qMatchedSum / qTokens.length;

  // Token precision: target tokens covered by query
  // Generic filler words don't penalize heavily if omitted by the rep
  const genericWords = options.genericWords || UNIVERSAL_GENERIC_WORDS;
  let tMatchedSum = 0;
  let unmentionedSpecificTokens = 0;

  for (const tTok of tTokens) {
    let best = 0;
    for (const qTok of qTokens) {
      if (tTok === qTok) { best = 1.0; break; }
      const sim = stringSimilarity(tTok, qTok);
      if (sim > best) best = sim;
    }
    if (best < 0.6) {
      if (genericWords.has(tTok)) {
        tMatchedSum += 0.5;
      } else {
        unmentionedSpecificTokens++;
      }
    } else {
      tMatchedSum += best;
    }
  }
  const precision = tMatchedSum / tTokens.length;

  // Harmonic mean (F1)
  const tokenF1 = (recall + precision > 0) ? (2 * recall * precision) / (recall + precision) : 0;

  // Token sort similarity
  const qSorted = [...qTokens].sort().join(' ');
  const tSorted = [...tTokens].sort().join(' ');
  const sortSim = stringSimilarity(qSorted, tSorted);

  let finalScore = 0.5 * recall + 0.3 * tokenF1 + 0.2 * sortSim;

  // If candidate has all its specific distinguishing tokens matched, give completeness boost
  if (unmentionedSpecificTokens === 0 && recall >= 0.8) {
    finalScore = Math.min(1.0, finalScore + 0.06);
  } else if (unmentionedSpecificTokens > 0) {
    finalScore -= 0.08 * unmentionedSpecificTokens;
  }

  return Math.max(0, finalScore);
}

/**
 * Match a text against a list of candidates.
 *
 * @param {string} query - Text from rep/LLM
 * @param {Array<{ name: string, ...rest }>} candidates - Catalog records
 * @param {Object} [options]
 * @param {Object} [options.aliases] - e.g. { "vk": "VK Enterprises" }
 * @param {number} [options.minScore]
 * @param {number} [options.confidentScore]
 * @param {number} [options.margin]
 *
 * @returns {{
 *   status: 'matched' | 'ambiguous' | 'none',
 *   match: Object | null,
 *   candidates: Array<{ candidate: Object, score: number }>,
 *   score: number
 * }}
 */
export function matchCandidate(query, candidates, options = {}) {
  const minScore = options.minScore ?? THRESHOLDS.MIN_SCORE;
  const confidentScore = options.confidentScore ?? THRESHOLDS.CONFIDENT_SCORE;
  const margin = options.margin ?? THRESHOLDS.MARGIN;
  const aliases = options.aliases || {};
  // If genericWords not passed, derive them automatically from the candidate set
  const genericWords = options.genericWords || deriveGenericTokens(candidates);
  const customReplacements = options.customReplacements;

  if (!query || typeof query !== 'string' || !query.trim()) {
    return { status: 'none', match: null, candidates: [], score: 0 };
  }

  const cleanedQuery = normalizeText(query, customReplacements);

  // 1. Direct alias check (e.g. "vk" -> "VK Enterprises")
  if (aliases[cleanedQuery]) {
    const aliasTarget = aliases[cleanedQuery].toLowerCase();
    const found = candidates.find((c) => c.name.toLowerCase() === aliasTarget);
    if (found) {
      return {
        status: 'matched',
        match: found,
        candidates: [{ candidate: found, score: 1.0 }],
        score: 1.0,
      };
    }
  }

  // 2. Score all candidates
  const scored = [];
  for (const item of candidates) {
    const score = computeSimilarity(cleanedQuery, item.name, { genericWords, customReplacements });
    if (score >= minScore) {
      scored.push({ candidate: item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    return { status: 'none', match: null, candidates: [], score: 0 };
  }

  const top = scored[0];
  const second = scored[1];

  // Exact full name match always wins
  if (top.score === 1.0 && (!second || second.score < 1.0)) {
    return {
      status: 'matched',
      match: top.candidate,
      candidates: scored.slice(0, 3),
      score: 1.0,
    };
  }

  // 3. Evaluate confident match vs ambiguous
  // Case A: High confidence threshold (>= 0.8) with margin over runner-up
  if (top.score >= confidentScore) {
    if (!second || (top.score - second.score) >= margin) {
      return {
        status: 'matched',
        match: top.candidate,
        candidates: scored.slice(0, 3),
        score: Number(top.score.toFixed(3)),
      };
    }
  }

  // Case B: Substantial score (>= 0.60) where ALL query tokens matched target (recall === 1.0)
  // and there is no competitive second candidate (no runner-up within 0.20)
  if (top.score >= 0.60 && (!second || (top.score - second.score) >= 0.20)) {
    return {
      status: 'matched',
      match: top.candidate,
      candidates: scored.slice(0, 3),
      score: Number(top.score.toFixed(3)),
    };
  }

  // If score is >= minScore but not sufficiently separated or not >= confidentScore
  return {
    status: 'ambiguous',
    match: null,
    candidates: scored.slice(0, 3),
    score: Number(top.score.toFixed(3)),
  };
}
