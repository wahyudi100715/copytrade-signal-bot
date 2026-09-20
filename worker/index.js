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

// Momentum is now built directly on the spike/growth signals the
// simplified strategy asks for: a real volume spike (ratio vs the hourly
// average pace, computed in pairFinder.js) plus holder count actually
// increasing (best-effort, from RugCheck — see security.js's
// getHolderGrowthSignal for the "no history on first check" caveat).
const SPIKE_RATIO_FOR_FULL_MOMENTUM_SCORE = 10; // ratio >= this maps to a full 1.0 volume-signal

function momentumScore(d) {
  const ratio = d.volumeSpikeRatio || 0;
  const volSignal = Number.isFinite(ratio) ? clip(ratio / SPIKE_RATIO_FOR_FULL_MOMENTUM_SCORE) : 1.0;

  const holdersNow = d.holderCount || 0;
  const holderSignal = holdersNow > 0 ? (d.holderCountGrowing ? 1.0 : 0.4) : 0.0;

  return clip(0.6 * volSignal + 0.4 * holderSignal);
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
  // GeckoTerminal's free tier has been returning HTTP 429 when hit every
  // single minute (see wrangler tail / dashboard Logs). pump.fun is the
  // primary source anyway, so only call GeckoTerminal once every 5 minutes
  // to cut our own contribution to that rate limit and save subrequest
  // budget for the RugCheck/DexScreener calls that matter more.
  const currentMinute = new Date().getUTCMinutes();
  const includeGecko = currentMinute % 5 === 0;

  // Simplified per spec: no static volume range anymore — pairFinder.js's
  // applyVolumeSpikeFilter() only lets through tokens with volume actually
  // accelerating right now (see SPIKE_MULTIPLIER there). Age/mc still gate
  // "new pool, still small" as asked.
  return getCandidateTokens(env, {
    maxAgeMin: 360,
    minMc: 1500,
    maxMc: 500_000,
    includeGecko,
  });
}

/**
 * Ported from TokenScanSD's functions/api/scan.js (fetchTokenDataSolana's
 * RugCheck half — GoPlus isn't in scan.js's Solana path, so it isn't here
 * either; see worker/security.js header for why).
 *
 * holderCount/holderCountGrowing now come from RugCheck via
 * security.js's getHolderGrowthSignal() (best-effort — see that file's
 * comment on the cold-start limitation). volume spike data comes straight
 * from the candidate (pairFinder.js already computed it before this point).
 */
async function enrichTokenData(env, candidate) {
  const security = await fetchSecurityData(candidate.mint, env);

  return {
    poolCreatedAt: candidate.poolCreatedAt,
    now: Math.floor(Date.now() / 1000),
    replyCount: candidate.replyCount || 0,
    replyCountGrowing: candidate.replyCountGrowing || false,
    volumeSpikeRatio: candidate.volumeSpikeRatio || 0,
    holderCount: security ? security.holderCount || 0 : 0,
    holderCountGrowing: security ? !!security.holderCountGrowing : false,
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

// Cloudflare Workers cap subrequests per invocation (50 on the free plan).
// Each candidate that reaches enrichTokenData() costs several subrequests
// (DexScreener volume/liquidity, RugCheck, KV reads/writes, possibly Helius
// fallback). Capping how many candidates get that far per cron tick keeps
// one busy minute from blowing the budget and erroring out the rest.
const MAX_CANDIDATES_PER_RUN = 5;

async function runScanLoop(env) {
  const candidates = await fetchCandidateTokens(env);
  const nowSec = Math.floor(Date.now() / 1000);
  let processed = 0;

  for (const candidate of candidates) {
    if (processed >= MAX_CANDIDATES_PER_RUN) {
      console.log(`Reached MAX_CANDIDATES_PER_RUN (${MAX_CANDIDATES_PER_RUN}), deferring the rest to next tick`);
      break;
    }

    const seenKey = `seen:${candidate.mint}`;
    const alreadySeen = await env.BOT_STATE.get(seenKey);
    if (alreadySeen) continue;

    // Cheap age check FIRST — candidate.poolCreatedAt is already in hand
    // from pairFinder.js, no network call needed. This is the same gate
    // calculateConfidenceScore() applies, just moved earlier so a stale or
    // too-fresh candidate never wastes a RugCheck/DexScreener subrequest.
    const poolAge = nowSec - (candidate.poolCreatedAt || nowSec);
    if (poolAge < SNIPE_WINDOW_SECONDS) {
      // Still within the snipe window — don't mark as seen, it may become
      // eligible on a later tick once enough time has passed.
      console.log(`Deferred ${candidate.mint}: pool only ${poolAge}s old, below ${SNIPE_WINDOW_SECONDS}s snipe window`);
      continue;
    }
    if (poolAge > SIGNAL_EXPIRY_SECONDS) {
      // Too old to ever qualify — mark seen so it's not rechecked forever.
      await env.BOT_STATE.put(seenKey, "1", { expirationTtl: 3600 * 24 });
      console.log(`Skipped ${candidate.mint} early: pool ${poolAge}s old, past ${SIGNAL_EXPIRY_SECONDS}s signal expiry`);
      continue;
    }

    processed++;
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
