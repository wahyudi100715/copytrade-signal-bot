/**
 * security.js — ported from TokenScanSD's functions/api/scan.js
 *
 * Only the SOLANA-relevant safety checks are ported here:
 *   - fetchRugcheckData      <- scan.js's function of the same name
 *   - fetchSolanaTopHoldersViaHelius <- same, used as RugCheck's fallback
 *
 * GoPlus is NOT ported: in scan.js, GoPlus token_security is only called
 * for EVM chains (BSC/Base/Ethereum/Arbitrum) via fetchGoPlusData(). It has
 * no role in scan.js's Solana path (fetchTokenDataSolana only calls
 * fetchDexPriceData + fetchRugcheckData). Since this bot only trades
 * Solana pump.fun tokens, porting GoPlus here would test a code path
 * scan.js itself doesn't use for Solana — so the confidence scorer's
 * "goplusRiskScore" slot is repurposed below (see index.js) to carry
 * RugCheck's own mint/freeze-authority-renounced signal instead.
 */

async function fetchRugcheckData(address) {
  let res;
  try {
    res = await fetch(`https://api.rugcheck.xyz/v1/tokens/${address}/report`);
  } catch (networkErr) {
    throw new Error(`RUGCHECK_NETWORK: ${networkErr.message}`);
  }
  if (!res.ok) throw new Error(`RUGCHECK_HTTP_${res.status}`);
  const data = await res.json();

  const topHolders = Array.isArray(data.topHolders) ? data.topHolders : [];
  let top1Pct = topHolders.length > 0 ? Number(((topHolders[0].pct) || 0).toFixed(1)) : null;
  let top10Pct = topHolders.length > 0
    ? Number(topHolders.slice(0, 10).reduce((sum, h) => sum + (h.pct || 0), 0).toFixed(1))
    : null;

  if (top1Pct === null) {
    // top1Pct === null also gates the Helius fallback here, same as scan.js.
    // Caller passes `env` through fetchSecurityData() below.
  }

  const realTotalHolders = typeof data.totalHolders === "number" && data.totalHolders > 0 ? data.totalHolders : null;
  const mintAuthorityRevoked = !data.token || data.token.mintAuthority === null;
  const freezeAuthorityRevoked = !data.token || data.token.freezeAuthority === null;

  const markets = Array.isArray(data.markets) ? data.markets : [];
  const hasLockerEntries = data.lockers && Object.keys(data.lockers).length > 0;
  const maxLpLockedPct = markets.reduce((max, m) => Math.max(max, (m.lp && m.lp.lpLockedPct) || 0), 0);
  const liquidityLocked = hasLockerEntries || maxLpLockedPct >= 50;

  const insiderNetworks = Array.isArray(data.insiderNetworks) ? data.insiderNetworks : [];
  const graphInsidersDetected = data.graphInsidersDetected || 0;
  const largestNetworkSize = insiderNetworks.reduce((max, n) => Math.max(max, n.size || 0), 0);
  const risks = data.risks || [];
  const bundlerRisk = risks.find((r) => (r.name || "").toLowerCase().includes("bundle"));

  const creatorAddress = (data.creator || "").toLowerCase();
  const creatorHolder = creatorAddress
    ? topHolders.find((h) => (h.owner || h.address || "").toLowerCase() === creatorAddress)
    : null;
  const devHolderPercent = creatorHolder ? Number((creatorHolder.pct || 0).toFixed(2)) : (creatorAddress ? 0 : null);

  const suspiciousWalletCount = insiderNetworks.length > 0 ? largestNetworkSize : 0;

  // scan.js doesn't compute a single "danger" flag from `risks`; it only
  // extracts the bundler one by name. For this bot's hard-reject gate we
  // need one, so: any risk RugCheck itself labels "danger" trips it.
  const hasDangerRisk = risks.some((r) => (r.level || "").toLowerCase() === "danger");

  return {
    topHolderPct: top1Pct,
    top10HolderPct: top10Pct,
    totalHolders: realTotalHolders,
    devHolderPercent,
    suspiciousWalletCount,
    liquidityLocked,
    ownershipRenounced: mintAuthorityRevoked && freezeAuthorityRevoked,
    graphInsidersDetected,
    insiderNetworkCount: insiderNetworks.length,
    largestNetworkSize,
    bundlerDetected: Boolean(bundlerRisk),
    hasDangerRisk,
    risks,
  };
}

async function fetchSolanaTopHoldersViaHelius(mintAddress, env) {
  const heliusKey = env && env.HELIUS_API_KEY;
  if (!heliusKey) return null;
  try {
    const rpc = async (method, params) => {
      const res = await fetch(`https://mainnet.helius-rpc.com/?api-key=${heliusKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      if (!res.ok) throw new Error(`HELIUS_RPC_HTTP_${res.status}`);
      const json = await res.json();
      if (json.error) throw new Error(`HELIUS_RPC_ERROR_${json.error.message || json.error.code}`);
      return json.result;
    };
    const [largestAccounts, supplyInfo] = await Promise.all([
      rpc("getTokenLargestAccounts", [mintAddress]),
      rpc("getTokenSupply", [mintAddress]),
    ]);
    const holders = (largestAccounts && largestAccounts.value) || [];
    const totalSupply = supplyInfo && supplyInfo.value && Number(supplyInfo.value.amount);
    if (!holders.length || !totalSupply) return null;
    const top1Pct = Number(((Number(holders[0].amount) / totalSupply) * 100).toFixed(1));
    const top10Amount = holders.slice(0, 10).reduce((sum, h) => sum + Number(h.amount), 0);
    const top10Pct = Number(((top10Amount / totalSupply) * 100).toFixed(1));
    return { top1Pct, top10Pct };
  } catch {
    return null;
  }
}

/**
 * Combined entry point for index.js's enrichTokenData(). Mirrors
 * scan.js's fetchTokenDataSolana(), minus the DexScreener call (pairFinder.js
 * already fetched volume/liquidity for the candidate, no need to fetch twice).
 *
 * Returns null (not a throw) on total failure so enrichTokenData() can fall
 * back to the safe defaults it already had — same "keep the loop running"
 * philosophy as the rest of the pipeline's try/catch blocks.
 */
async function fetchSecurityData(mint, env) {
  try {
    const rug = await fetchRugcheckData(mint);
    if (rug.topHolderPct === null) {
      const fallback = await fetchSolanaTopHoldersViaHelius(mint, env);
      if (fallback) {
        rug.topHolderPct = fallback.top1Pct;
        rug.top10HolderPct = fallback.top10Pct;
      }
    }
    return rug;
  } catch (err) {
    console.error(`fetchSecurityData(${mint}) failed:`, err.message);
    return null;
  }
}

export { fetchRugcheckData, fetchSolanaTopHoldersViaHelius, fetchSecurityData };
