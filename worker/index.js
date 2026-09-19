const SNIPE_WINDOW_SECONDS = 180;
const SIGNAL_EXPIRY_SECONDS = 3600;
const ENTRY_THRESHOLD = 70;

const WEIGHTS = {
  social: 0.30,
  momentum: 0.30,
  safety: 0.40,
};

function clip(x, lo = 0, hi = 1) {
  return Math.max(lo, Math.min(hi, x));
}

function socialScore(d) {
  const mentions = d.kolMentionsCount || 0;
  const growing = !!d.kolMentionsGrowing;
  const base = clip(mentions / 3.0);
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

async function fetchCandidateTokens(env) {
  return [];
}

async function enrichTokenData(env, candidate) {
  return {
    poolCreatedAt: candidate.poolCreatedAt,
    now: Math.floor(Date.now() / 1000),
    kolMentionsCount: candidate.kolMentionsCount || 0,
    kolMentionsGrowing: candidate.kolMentionsGrowing || false,
    holderCount: 0,
    holderCount15minAgo: 0,
    volume5minUsd: 0,
    volumePrior5minUsd: 0,
    liquidityUsd: 0,
    lpLocked: false,
    top10HolderPct: 100,
    devHolderPct: 100,
    goplusRiskScore: 0,
    rugcheckFlag: false,
  };
}

async function executeEntry(env, tokenData, scoreResult) {
  await notifyTelegram(
    env,
    `PAPER ENTRY signal - Token: ${tokenData.symbol || "?"} - Score: ${scoreResult.total.toFixed(1)} - Breakdown: ${JSON.stringify(scoreResult.breakdown)}`
  );
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

async function runScanLoop(env) {
  const candidates = await fetchCandidateTokens(env);

  for (const candidate of candidates) {
    const seenKey = `seen:${candidate.mint}`;
    const alreadySeen = await env.BOT_STATE.get(seenKey);
    if (alreadySeen) continue;

    const tokenData = await enrichTokenData(env, candidate);
    const scoreResult = calculateConfidenceScore(tokenData);

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

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runScanLoop(env));
  },

  async fetch(request, env, ctx) {
    await runScanLoop(env);
    return new Response("Scan loop executed manually. Check wrangler tail for logs.");
  },
};
