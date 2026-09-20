/**
 * copytrade-signal-bot — Cloudflare Worker
 *
 * Cron-triggered "human analysis, bot execution" entry-decision loop,
 * ported from confidence_signal_scorer.py. Same gate + weighted scoring
 * logic — see that file for the reasoning behind each number.
 *
 * This file is intentionally split into clearly-labeled sections so you
 * can wire in real data source calls (Helius, GoPlus, DexScreener,
 * kol_token_scanner output) one at a time and test each with
 * `npx wrangler tail` before trusting the whole loop.
 */

import { getCandidateTokens } from "./pairFinder.js";
import { fetchSecurityData } from "./security.js";

// ---- Tunable parameters (mirrors confidence_signal_scorer.py) ----------

const SNIPE_WINDOW_SECONDS = 180;
const SIGNAL_EXPIRY_SECONDS = 3600;
const ENTRY_THRESHOLD = 70;

const WEIGHTS = {
  social: 0.30,
  momentum: 0.30,
  safety: 0.40,
};

// ---- Scoring functions (ported from confidence_signal_scorer.py) ------

function clip(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

// Reply count where a token earns full base social score if it has at
// least this many pump.fun comments. Tune this against real data — pump.fun
// reply counts run much higher than KOL-mention counts ever did (that old
// scale was mentions/3.0; replies need a bigger denominator).
const REPLIES_FOR_FULL_SOCIAL_SCORE = 20;

function socialScore(d) {
  const replies = d.replyCount || 0;
  const growing = !!d.replyCountGrowing;
  const base = clip(replies / REPLIES_FOR_FULL_SOCIAL_SCORE);
  const growthBonus = growing ? 0.2 : 0.0;
  return clip(base + growthBonus);
}

function momentumScore(d) {
  const volNow = d.volume5minUsd || 0;
  const volPrev = d.volumePrior5minUsd || 0;
  const holdersNow = d.holderCount || 0;
  const holdersPrev = d.holderCount15minAgo || 0;

  let volSignal;
  if (volPrev <= 0) {
    volSignal = volNow > 0 ? 0.5 : 0.0;
  } else {
    const ratio = volNow / volPrev;
    volSignal = clip((ratio - 1.0) / 1.0);
  }

  let holderSignal;
  if (holdersPrev <= 0) {
    holderSignal = holdersNow > 0 ? 0.5 : 0.0;
  } else {
    const growth = (holdersNow - holdersPrev) / holdersPrev;
    holderSignal = clip(growth / 0.20);
  }

  return clip(0.5 * volSignal + 0.5 * holderSignal);
}

function safetyScore(d) {
  if (d.rugcheckFlag) return 0.0;

  const lpLocked = d.lpLocked ? 1.0 : 0.0;

  const top10 = d.top10HolderPct ?? 100.0;
  const top10Signal = clip((50.0 - top10) / 50.0);

  const devPct = d.devHolderPct ?? 100.0;
  const devSignal = clip((15.0 - devPct) / 15.0);

  const goplus = clip((d.goplusRiskScore || 0) / 100.0);

  const liquidity = d.liquidityUsd || 0;
  const liqSignal = clip(liquidity / 20000.0);

  return clip(
    0.25 * lpLocked +
    0.20 * top10Signal +
    0.15 * devSignal +
    0.25 * goplus +
    0.15 * liqSignal
  );
}

function calculateConfidenceScore(tokenData) {
  const poolAge = tokenData.now - tokenData.poolCreatedAt;

  if (poolAge < SNIPE_WINDOW_SECONDS) {
    return {
      total: 0,
      breakdown: {},
      gatedOut: true,
      gateReason: `pool only ${poolAge.toFixed(0)}s old, below ${SNIPE_WINDOW_SECONDS}s snipe window`,
      entryAllowed: false,
    };
  }

  if (poolAge > SIGNAL_EXPIRY_SECONDS) {
    return {
      total: 0,
      breakdown: {},
      gatedOut: true,
      gateReason: `pool ${poolAge.toFixed(0)}s old, past ${SIGNAL_EXPIRY_SECONDS}s signal expiry`,
      entryAllowed: false,
    };
  }

  if (tokenData.rugcheckFlag) {
    return {
      total: 0,
      breakdown: { safety: 0 },
      gatedOut: true,
      gateReason: "RugCheck flagged this token",
      entryAllowed: false,
    };
  }

  const scores = {
    social: socialScore(tokenData),
    momentum: momentumScore(tokenData),
    safety: safetyScore(tokenData),
  };

  const total =
    (scores.social * WEIGHTS.social +
      scores.momentum * WEIGHTS.momentum +
      scores.safety * WEIGHTS.safety) * 100;

  return {
    total,
    breakdown: scores,
    gatedOut: false,
    gateReason: "",
    entryAllowed: total >= ENTRY_THRESHOLD,
  };
}

// ---- Data sources -------------------------------------------------------

/**
 * Live now: pulls pump.fun bonding-curve tokens + GeckoTerminal new pools,
 * merges, filters by age/mc/volume — ported 1:1 from newpair_kol_filter.py.
 * See worker/pairFinder.js header comment for what was and wasn't ported
 * (the KOL/X-mention layer needs a data source of its own — it was manual
 * input in the Python version too, not automated scraping).
 */
async function fetchCandidateTokens(env) {
  return getCandidateTokens(env, {
    maxAgeMin: 360,
    minMc: 1500,
    maxMc: 500_000,
    minVol: 20_000,
    maxVol: 100_000,
  });
}

/**
 * Ported from TokenScanSD's functions/api/scan.js (fetchTokenDataSolana's
 * RugCheck half — GoPlus isn't in scan.js's Solana path, so it isn't here
 * either; see worker/security.js header for why).
 *
 * STILL TODO: holderCount/holderCount15minAgo, volume5minUsd/
 * volumePrior5minUsd need a *rolling* comparison across scans (like
 * replyCount growth in pairFinder.js), which scan.js doesn't provide —
 * it only returns a snapshot, not history. Left at 0 until a KV-backed
 * rolling snapshot is added the same way getReplyGrowthSignal() works.
 */
async function enrichTokenData(env, candidate) {
  const security = await fetchSecurityData(candidate.mint, env);

  return {
    poolCreatedAt: candidate.poolCreatedAt,
    now: Math.floor(Date.now() / 1000),
    replyCount: candidate.replyCount || 0,
    replyCountGrowing: candidate.replyCountGrowing || false,
    holderCount: 0,
    holderCount15minAgo: 0,
    volume5minUsd: 0,
    volumePrior5minUsd: 0,
    liquidityUsd: candidate.liquidityUsd || 0,
    lpLocked: security ? !!security.liquidityLocked : false,
    top10HolderPct: security && security.top10HolderPct !== null ? security.top10HolderPct : 100,
    devHolderPct: security && security.devHolderPercent !== null ? security.devHolderPercent : 100,
    // No GoPlus call for Solana in scan.js (see worker/security.js header) —
    // this slot is repurposed to carry RugCheck's own mint/freeze-authority
    // -renounced signal instead of leaving it permanently at 0.
    goplusRiskScore: security && security.ownershipRenounced ? 100 : 0,
    rugcheckFlag: security ? !!security.hasDangerRisk : false,
  };
}

/**
 * TODO: wire to Jupiter Aggregator API + transaction signing.
 * Keep this as a no-op / paper-trade log until you've validated the
 * scoring pipeline against real historical outcomes.
 */
async function executeEntry(env, tokenData, scoreResult) {
  await notifyTelegram(
    env,
    `🟢 PAPER ENTRY signal\nToken: ${tokenData.symbol || "?"}\nScore: ${scoreResult.total.toFixed(1)}\nBreakdown: ${JSON.stringify(scoreResult.breakdown)}`
  );
  // Real execution goes here once you're ready to go live:
  // 1. build swap via Jupiter quote+swap API
  // 2. sign with WALLET_PRIVATE_KEY secret
  // 3. broadcast via Helius/RPC
  // 4. record the position in KV so a separate loop can manage TP/SL/max-hold
}

async function notifyTelegram(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
    });
  } catch (err) {
    console.error("Telegram notify failed:", err);
  }
}

// ---- Main scan loop -----------------------------------------------------

async function runScanLoop(env) {
  const candidates = await fetchCandidateTokens(env);

  for (const candidate of candidates) {
    const seenKey = `seen:${candidate.mint}`;
    const alreadySeen = await env.BOT_STATE.get(seenKey);
    if (alreadySeen) continue;

    const tokenData = await enrichTokenData(env, candidate);
    const scoreResult = calculateConfidenceScore(tokenData);

    // Mark as seen regardless of outcome so we don't re-score every minute.
    await env.BOT_STATE.put(seenKey, "1", { expirationTtl: SIGNAL_EXPIRY_SECONDS + 300 });

    if (scoreResult.gatedOut) {
      console.log(`Skipped ${candidate.mint}: ${scoreResult.gateReason}`);
      continue;
    }

    console.log(`Scored ${candidate.mint}: ${scoreResult.total.toFixed(1)}`);

    if (scoreResult.entryAllowed) {
      await executeEntry(env, { ...tokenData, symbol: candidate.symbol }, scoreResult);
    }
  }
}

// ---- Worker entrypoints --------------------------------------------------

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScanLoop(env));
  },

  // Manual trigger for testing: visit the Worker URL in a browser.
  async fetch(request, env, ctx) {
    await runScanLoop(env);
    return new Response("Scan loop executed manually. Check `wrangler tail` for logs.");
  },
};
