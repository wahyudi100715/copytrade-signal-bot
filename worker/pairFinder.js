/**
 * pairFinder.js — ported from newpair_kol_filter.py
 *
 * Direct 1:1 port of the parts of the Python script that are fully
 * automatic (no manual input required):
 *   - fetch_pump_coins / fetch_pump_pregrad  -> fetchPumpCoins / fetchPumpPregrad
 *   - fetch_gecko_new_pools                  -> fetchGeckoNewPools
 *   - merge_pairs                            -> mergePairs
 *   - apply_newpair_filters                  -> applyNewpairFilters
 *   - fetch_dexscreener_volume_h24 +
 *     apply_volume_filter                    -> fetchDexscreenerVolumeH24 / applyVolumeFilter
 *
 * NOT ported as-is: the Python script's KOL/X-mention layer (attach_kol_layer)
 * scores candidates using `x_hits.json`, which is itself produced by
 * kol_token_scanner.py from MANUALLY supplied tweet text (see that script's
 * --posts argument and its own "cadangan"/backup framing in README.md).
 * There is no live X/Twitter scraping in the original pipeline to port.
 *
 * Replaced with: pump.fun's own `reply_count` (already present in the API
 * response fetchPumpCoins() reads) as a fully-automatic social-attention
 * proxy — no manual input needed. getReplyGrowthSignal() below compares
 * each scan's reply count against the previous scan (stored in KV) to
 * detect accelerating community interest, the same "growing" concept the
 * momentum score already applies to volume/holders.
 *
 * The OKX hot-token signal (apply_okx_signal in Python) is also left out
 * for now — it's optional there too (skipped when OKX credentials are
 * empty) and can be added later the same way GoPlus/RugCheck get added
 * to enrichTokenData() in index.js.
 */

const NOISE_SYMBOLS = new Set([
  "SOL", "WSOL", "USDC", "USDT", "BTC", "WBTC", "ETH", "WETH", "USD",
  "JUP", "JLP", "JITOSOL", "MSOL", "BNSOL",
]);

const FETCH_HEADERS = {
  "User-Agent": "Mozilla/5.0 KOLNewPairFilter/1.0",
  "Accept": "application/json",
};

function nowTs() {
  return Date.now() / 1000;
}

function ageMinutes(createdTs) {
  if (!createdTs) return null;
  const ts = createdTs > 1e12 ? createdTs / 1000 : createdTs;
  return Math.max(0, (nowTs() - ts) / 60);
}

async function httpGetJson(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// ---- fetch_pump_coins / fetch_pump_pregrad -----------------------------

async function fetchPumpCoins(complete, limit = 40, sort = "created_timestamp") {
  let url =
    `https://frontend-api-v3.pump.fun/coins` +
    `?offset=0&limit=${limit}&sort=${sort}&order=DESC&includeNsfw=false`;
  if (complete === true) url += "&complete=true";
  else if (complete === false) url += "&complete=false";

  const raw = await httpGetJson(url);
  const out = [];
  for (const c of raw) {
    const symbol = (c.symbol || "").replace(/^\$/, "").toUpperCase();
    if (!symbol || NOISE_SYMBOLS.has(symbol)) continue;
    const created = c.created_timestamp;
    out.push({
      source: c.complete ? "pump.fun-graduated" : "pump.fun-new",
      chain: "solana",
      symbol,
      name: c.name || symbol,
      mint: c.mint,
      pair: c.pool_address || c.bonding_curve,
      market_cap_usd: Number(c.usd_market_cap || c.market_cap_usd || 0),
      created_ts: created && created > 1e12 ? created / 1000 : created,
      twitter: c.twitter || null,
      description: c.description || "",
      graduated: !!c.complete,
      replies: Number(c.reply_count || 0),
      image: c.image_uri || "",
      real_sol: Number(c.real_sol_reserves || 0) / 1e9,
    });
  }
  return out;
}

async function fetchPumpPregrad(limitEach = 50) {
  const rows = [];
  for (const sort of ["created_timestamp", "last_trade_timestamp", "market_cap"]) {
    try {
      const part = await fetchPumpCoins(false, limitEach, sort);
      rows.push(...part);
    } catch (err) {
      console.error(`fetchPumpCoins(${sort}) failed:`, err.message);
    }
  }
  const pre = rows.filter((r) => !r.graduated);
  for (const r of pre) {
    r.source = "pump.fun-bonding";
    r.bonding_pct = Math.round(Math.min(99.9, ((r.real_sol || 0) / 85) * 100) * 10) / 10;
  }
  return pre;
}

// ---- fetch_gecko_new_pools ----------------------------------------------

async function fetchGeckoNewPools(limit = 30) {
  const data = await httpGetJson("https://api.geckoterminal.com/api/v2/networks/solana/new_pools?page=1");
  const included = {};
  for (const item of data.included || []) {
    if (item.type === "token") included[item.id] = item;
  }

  const out = [];
  for (const pool of data.data || []) {
    const attrs = pool.attributes || {};
    const name = attrs.name || "";
    if (!name.includes("/")) continue;
    const [baseSymRaw, quoteSymRaw] = name.split("/", 2);
    const baseSym = baseSymRaw.trim().toUpperCase();
    const quoteSym = quoteSymRaw.trim().toUpperCase();
    if (!["SOL", "WSOL"].includes(quoteSym) || NOISE_SYMBOLS.has(baseSym)) continue;

    const rel = ((pool.relationships || {}).base_token || {}).data || {};
    const token = included[rel.id] || {};
    const tokenAttrs = token.attributes || {};
    const created = attrs.pool_created_at;
    const createdTs = created ? new Date(created).getTime() / 1000 : null;
    const vol = Number((attrs.volume_usd || {}).h24 || 0);
    const reserve = Number(attrs.reserve_in_usd || 0);
    const mint = tokenAttrs.address;
    if (!mint) continue;

    out.push({
      source: "geckoterminal-newpool",
      chain: "solana",
      symbol: baseSym,
      name: tokenAttrs.name || baseSym,
      mint,
      pair: (pool.id || "").split("solana_").pop(),
      market_cap_usd: 0,
      liquidity_usd: reserve,
      volume_24h: vol,
      created_ts: createdTs,
      twitter: null,
      description: "",
      graduated: true,
      replies: 0,
      image: "",
    });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- merge_pairs ---------------------------------------------------------

function mergePairs(rows) {
  const book = new Map();
  for (const row of rows) {
    const mint = row.mint;
    if (!mint) continue;
    if (!book.has(mint)) {
      book.set(mint, row);
      continue;
    }
    const cur = book.get(mint);
    if (row.graduated && !cur.graduated) {
      book.set(mint, { ...cur, ...row });
    } else {
      if (!cur.twitter) cur.twitter = row.twitter;
      cur.market_cap_usd = Math.max(cur.market_cap_usd || 0, row.market_cap_usd || 0);
      if (row.source && !(cur.source || "").includes(row.source)) {
        cur.source = `${cur.source}+${row.source}`;
      }
    }
  }
  return Array.from(book.values());
}

// ---- apply_newpair_filters -----------------------------------------------

function applyNewpairFilters(rows, maxAgeMin, minMc, maxMc) {
  const kept = [];
  for (const row of rows) {
    const age = ageMinutes(row.created_ts);
    row.age_min = age !== null ? Math.round(age * 10) / 10 : null;
    if (age !== null && age > maxAgeMin) continue;
    const mc = row.market_cap_usd || 0;
    if (mc > 0 && (mc < minMc || mc > maxMc)) continue;
    kept.push(row);
  }
  return kept;
}

// ---- Volume SPIKE detection (replaces the static min/max volume range) --
//
// This is the core of the simplified strategy: only tokens with volume
// ACCELERATING right now, not just tokens that happen to sit in some
// absolute volume range. DexScreener already gives a 5-minute window
// (volume.m5) alongside the 1-hour window (volume.h1) for most pairs —
// no need to build our own rolling snapshot for this one, unlike replies
// or holders which only come back as flat totals.
//
// Spike condition: 5-minute volume is well above what a flat, non-spiking
// hour would imply (h1 / 12 = expected volume per 5-minute slice). A ratio
// of 1 means "trading exactly at the hourly average pace"; SPIKE_MULTIPLIER
// requires meaningfully faster-than-average trading right now.

const SPIKE_MULTIPLIER = 2; // m5 volume must be >= 2x the hourly-average 5-min pace
const MIN_M5_VOLUME_USD = 300; // floor so near-zero-volume pairs don't produce noisy "infinite" ratios

async function fetchDexscreenerPairSummary(mint) {
  try {
    const raw = await httpGetJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`, 15000);
    const pairs = raw.pairs || [];
    if (!pairs.length) return null;
    // pick the pair with the most liquidity, same tie-break TokenScanSD's
    // scan.js uses in fetchDexScreenerData()
    const primary = pairs.reduce((best, cur) => {
      const liq = (cur.liquidity && cur.liquidity.usd) || 0;
      const bestLiq = (best && best.liquidity && best.liquidity.usd) || 0;
      return liq > bestLiq ? cur : best;
    }, pairs[0]);
    const vol = primary.volume || {};
    return {
      volume24h: Number(vol.h24 || 0),
      volumeH1: Number(vol.h1 || 0),
      volumeM5: Number(vol.m5 || 0),
      liquidityUsd: Number((primary.liquidity || {}).usd || 0),
    };
  } catch {
    return null;
  }
}

// Kept for backward compatibility with anything calling the old name directly.
async function fetchDexscreenerVolumeH24(mint) {
  const summary = await fetchDexscreenerPairSummary(mint);
  return summary ? summary.volume24h : null;
}

function computeVolumeSpike(summary) {
  if (!summary) return { isSpike: false, ratio: 0 };
  if (summary.volumeM5 < MIN_M5_VOLUME_USD) return { isSpike: false, ratio: 0 };
  const expectedPer5min = summary.volumeH1 / 12;
  if (expectedPer5min <= 0) {
    // No hourly history yet (brand new pair) but real 5-min volume exists —
    // treat as a spike since there's nothing to compare against but activity
    // is clearly happening.
    return { isSpike: true, ratio: Infinity };
  }
  const ratio = summary.volumeM5 / expectedPer5min;
  return { isSpike: ratio >= SPIKE_MULTIPLIER, ratio };
}

async function applyVolumeSpikeFilter(rows) {
  const kept = [];
  for (const row of rows) {
    const summary = await fetchDexscreenerPairSummary(row.mint);
    const spike = computeVolumeSpike(summary);
    row.volume_24h = summary ? summary.volume24h : null;
    row.volume_m5 = summary ? summary.volumeM5 : null;
    row.liquidity_usd = summary ? summary.liquidityUsd : (row.liquidity_usd || 0);
    row.volume_spike_ratio = spike.ratio;
    if (!spike.isSpike) continue;
    kept.push(row);
  }
  return kept;
}

// ---- Community reply momentum (replaces the KOL/X-mention layer) ---------

/**
 * pump.fun's own `reply_count` (already fetched in fetchPumpCoins as
 * `replies`) is a fully-automatic proxy for social attention — no manual
 * tweet input needed, unlike the Python script's x_hits.json layer.
 *
 * This compares the current reply count against the count from the last
 * scan (stored in KV) to detect whether reply activity is ACCELERATING,
 * not just present — same "growing" concept the momentum score already
 * uses for volume/holders, applied here to replies instead.
 *
 * KV key: `replies:<mint>` -> JSON { "count": number, "ts": epoch-seconds }
 */
const REPLY_GROWTH_MIN_INCREASE = 3; // at least this many new replies since last scan counts as "growing"

async function getReplyGrowthSignal(env, mint, currentReplies) {
  const count = currentReplies || 0;
  if (!env.BOT_STATE) return { count, growing: false };

  const key = `replies:${mint}`;
  let growing = false;
  try {
    const raw = await env.BOT_STATE.get(key);
    if (raw) {
      const prev = JSON.parse(raw);
      if (count - (prev.count || 0) >= REPLY_GROWTH_MIN_INCREASE) {
        growing = true;
      }
    }
    await env.BOT_STATE.put(
      key,
      JSON.stringify({ count, ts: Math.floor(Date.now() / 1000) }),
      { expirationTtl: 3600 * 6 } // stale snapshots auto-expire after 6h
    );
  } catch (err) {
    console.error(`getReplyGrowthSignal(${mint}) KV error:`, err.message);
  }
  return { count, growing };
}

// ---- Orchestration: replaces the empty fetchCandidateTokens() stub --------

/**
 * Simplified strategy (per explicit spec): don't scan every token — only
 * chase ones showing a real volume spike right now, small market cap, and
 * a new pool. Safety (RugCheck) is checked AFTER this filter, only for the
 * few survivors, not for every raw pump.fun listing.
 */
async function getCandidateTokens(env, options = {}) {
  const {
    maxAgeMin = 360,
    minMc = 1500,
    maxMc = 500_000,
    pregradLimit = 50,
    geckoLimit = 30,
    includeGecko = true,
  } = options;

  const fetched = [];
  try {
    fetched.push(...(await fetchPumpPregrad(pregradLimit)));
  } catch (err) {
    console.error("fetchPumpPregrad failed:", err.message);
  }
  if (includeGecko) {
    try {
      fetched.push(...(await fetchGeckoNewPools(geckoLimit)));
    } catch (err) {
      console.error("fetchGeckoNewPools failed:", err.message);
    }
  }

  let merged = mergePairs(fetched);
  merged = applyNewpairFilters(merged, maxAgeMin, minMc, maxMc);

  // Cap BEFORE the DexScreener spike-check loop — each row costs one
  // subrequest there, so bounding the list first keeps Cloudflare's
  // 50-subrequest-per-invocation budget from being spent before RugCheck
  // (called later, in index.js, for the few survivors) gets its turn.
  const MAX_MERGED_CANDIDATES = 15;
  if (merged.length > MAX_MERGED_CANDIDATES) {
    console.log(`Trimming ${merged.length} merged candidates down to ${MAX_MERGED_CANDIDATES} to stay within subrequest/CPU budget`);
    merged = merged.slice(0, MAX_MERGED_CANDIDATES);
  }

  // THE core filter for this strategy: only tokens with volume actually
  // accelerating right now survive past here.
  merged = await applyVolumeSpikeFilter(merged);

  const candidates = [];
  for (const row of merged) {
    const reply = await getReplyGrowthSignal(env, row.mint, row.replies);
    candidates.push({
      mint: row.mint,
      symbol: row.symbol,
      poolCreatedAt: row.created_ts,
      replyCount: reply.count,
      replyCountGrowing: reply.growing,
      // carried through so enrichTokenData() in index.js doesn't need a
      // second DexScreener call just to get what we already fetched here
      volume24hFromDexscreener: row.volume_24h,
      volumeM5: row.volume_m5 || 0,
      volumeSpikeRatio: row.volume_spike_ratio || 0,
      liquidityUsd: row.liquidity_usd || 0,
    });
  }
  return candidates;
}

export {
  fetchPumpCoins,
  fetchPumpPregrad,
  fetchGeckoNewPools,
  mergePairs,
  applyNewpairFilters,
  fetchDexscreenerVolumeH24,
  fetchDexscreenerPairSummary,
  computeVolumeSpike,
  applyVolumeSpikeFilter,
  getReplyGrowthSignal,
  getCandidateTokens,
};
