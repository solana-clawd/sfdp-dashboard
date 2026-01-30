// Enhanced SFDP data collector with full validator decentralization metrics
const fs = require("fs");
const path = require("path");

const RPC = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";
const DATA_DIR = path.join(__dirname, "data");

const AUTHORITIES = {
  firep: { authority: "FiRep26iRQbMaKbqhhs5CqXqy7YrHn462LbnQhXzB2ps", label: "SFDP Main (FiRep)" },
  mpa4: { authority: "mpa4abUkjQoAvPzREkh5Mo75hZhPFQ2FSH6w7dWKuQ5", label: "SFDP Matching/Residual (mpa4)" },
};

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function getStakeAccounts(authority) {
  return rpc("getProgramAccounts", [
    "Stake11111111111111111111111111111111111111",
    { encoding: "jsonParsed", filters: [{ memcmp: { offset: 12, bytes: authority } }] },
  ]);
}

async function getStakeAccountsByWithdraw(authority) {
  return rpc("getProgramAccounts", [
    "Stake11111111111111111111111111111111111111",
    { encoding: "jsonParsed", filters: [{ memcmp: { offset: 44, bytes: authority } }] },
  ]);
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const epochInfo = await rpc("getEpochInfo", []);
  console.log(`Epoch ${epochInfo.epoch} (${((epochInfo.slotIndex/epochInfo.slotsInEpoch)*100).toFixed(1)}%)`);

  // Get validator metadata from stakewiz
  console.log("Fetching validator metadata...");
  const swRes = await fetch("https://api.stakewiz.com/validators");
  const stakewizData = await swRes.json();
  const valMap = {};
  for (const v of stakewizData) {
    valMap[v.vote_identity] = v;
  }
  console.log(`  ${stakewizData.length} validators from stakewiz`);

  // Get vote accounts for commission/performance
  console.log("Fetching vote accounts...");
  const voteAccounts = await rpc("getVoteAccounts", [{ commitment: "confirmed" }]);
  const voteMap = {};
  for (const v of [...(voteAccounts.current || []), ...(voteAccounts.delinquent || [])]) {
    voteMap[v.votePubkey] = {
      commission: v.commission,
      activatedStake: v.activatedStake,
      lastVote: v.lastVote,
      delinquent: false,
    };
  }
  for (const v of (voteAccounts.delinquent || [])) {
    if (voteMap[v.votePubkey]) voteMap[v.votePubkey].delinquent = true;
  }

  // Get block production
  console.log("Fetching block production...");
  const bp = await rpc("getBlockProduction", [{ commitment: "confirmed" }]);
  const bpMap = {};
  for (const [id, [slots, blocks]] of Object.entries(bp.value?.byIdentity || {})) {
    bpMap[id] = { leaderSlots: slots, blocksProduced: blocks, skipRate: slots > 0 ? ((slots - blocks) / slots * 100) : 0 };
  }

  // Collect stake accounts for both authorities (try both staker and withdraw offsets)
  const result = {
    timestamp: new Date().toISOString(),
    epoch: epochInfo.epoch,
    slot: epochInfo.absoluteSlot,
    epochPct: ((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2),
    networkValidators: (voteAccounts.current || []).length + (voteAccounts.delinquent || []).length,
    accounts: {},
  };

  for (const [key, config] of Object.entries(AUTHORITIES)) {
    console.log(`\nCollecting ${config.label}...`);
    const stakeAccounts = await getStakeAccounts(config.authority);
    console.log(`  ${stakeAccounts.length} stake accounts`);

    // Analyze
    const validators = {};
    let totalActive = 0, totalDeactivating = 0, totalEmpty = 0;

    for (const acct of stakeAccounts) {
      const del = acct.account?.data?.parsed?.info?.stake?.delegation;
      if (!del) { totalEmpty++; continue; }
      const stake = parseInt(del.stake) / 1e9;
      const voter = del.voter;
      const deactivating = del.deactivationEpoch !== "18446744073709551615";
      if (deactivating) totalDeactivating += stake;
      else totalActive += stake;

      if (!validators[voter]) validators[voter] = { voter, activeStake: 0, deactivatingStake: 0, accounts: 0 };
      validators[voter].accounts++;
      if (deactivating) validators[voter].deactivatingStake += stake;
      else validators[voter].activeStake += stake;
    }

    const sorted = Object.values(validators).sort((a, b) => b.activeStake - a.activeStake);
    const activeVals = sorted.filter(v => v.activeStake > 0);

    // Enrich with metadata
    const enriched = sorted.map(v => {
      const sw = valMap[v.voter] || {};
      const va = voteMap[v.voter] || {};
      const bpd = bpMap[sw.identity] || {};
      return {
        ...v,
        name: sw.name || null,
        commission: va.commission ?? sw.commission ?? null,
        totalNetworkStake: (va.activatedStake || 0) / 1e9,
        version: sw.version || null,
        delinquent: va.delinquent || sw.delinquent || false,
        skipRate: sw.wiz_skip_rate ?? bpd.skipRate ?? null,
        leaderSlots: bpd.leaderSlots || null,
        blocksProduced: bpd.blocksProduced || null,
        country: sw.ip_country || null,
        city: sw.ip_city || null,
        asn: sw.asn || sw.ip_asn || null,
        asnOrg: sw.ip_org || null,
        isJito: sw.is_jito || false,
        jitoCommission: sw.jito_commission_bps || null,
        wizScore: sw.wiz_score || null,
        apy: sw.total_apy || sw.apy_estimate || null,
        superminority: sw.superminority_penalty > 0,
        asnConcentration: sw.asn_concentration || null,
        cityConcentration: sw.city_concentration || null,
        pctOfPool: totalActive > 0 ? (v.activeStake / totalActive * 100) : 0,
      };
    });

    // Decentralization metrics
    const stakes = activeVals.map(v => v.activeStake);

    // Nakamoto
    let running = 0, nak33 = 0;
    for (const s of stakes) { running += s; nak33++; if (running >= totalActive / 3) break; }

    // HHI
    let hhi = 0;
    stakes.forEach(s => { const sh = s / totalActive; hhi += sh * sh; });

    // Gini
    const n = stakes.length;
    const asc = [...stakes].sort((a, b) => a - b);
    let giniSum = 0;
    for (let i = 0; i < n; i++) giniSum += (2 * (i + 1) - n - 1) * asc[i];
    const gini = n > 0 ? giniSum / (n * asc.reduce((a, b) => a + b, 0)) : 0;

    // Geographic concentration
    const countries = {}, cities = {}, asns = {}, versions = {}, commissions = {};
    for (const v of enriched) {
      if (v.activeStake <= 0) continue;
      const c = v.country || "Unknown";
      const ci = v.city || "Unknown";
      const a = v.asnOrg || v.asn || "Unknown";
      const ver = v.version || "Unknown";
      const com = v.commission != null ? v.commission : "Unknown";

      if (!countries[c]) countries[c] = { count: 0, stake: 0 };
      countries[c].count++; countries[c].stake += v.activeStake;

      if (!cities[ci]) cities[ci] = { count: 0, stake: 0 };
      cities[ci].count++; cities[ci].stake += v.activeStake;

      if (!asns[a]) asns[a] = { count: 0, stake: 0 };
      asns[a].count++; asns[a].stake += v.activeStake;

      if (!versions[ver]) versions[ver] = { count: 0, stake: 0 };
      versions[ver].count++; versions[ver].stake += v.activeStake;

      if (!commissions[com]) commissions[com] = { count: 0, stake: 0 };
      commissions[com].count++; commissions[com].stake += v.activeStake;
    }

    const sortObj = (obj) => Object.entries(obj)
      .map(([k, v]) => ({ name: k, ...v, pct: (v.stake / totalActive * 100).toFixed(2) }))
      .sort((a, b) => b.stake - a.stake);

    // Stake buckets
    const buckets = [
      { label: "<1K", min: 0, max: 1000, count: 0, stake: 0 },
      { label: "1K-10K", min: 1000, max: 10000, count: 0, stake: 0 },
      { label: "10K-50K", min: 10000, max: 50000, count: 0, stake: 0 },
      { label: "50K-100K", min: 50000, max: 100000, count: 0, stake: 0 },
      { label: "100K-500K", min: 100000, max: 500000, count: 0, stake: 0 },
      { label: "500K+", min: 500000, max: Infinity, count: 0, stake: 0 },
    ];
    for (const v of activeVals) {
      for (const b of buckets) {
        if (v.activeStake >= b.min && v.activeStake < b.max) { b.count++; b.stake += v.activeStake; break; }
      }
    }

    // Jito stats
    const jitoVals = enriched.filter(v => v.isJito && v.activeStake > 0);
    const jitoStake = jitoVals.reduce((s, v) => s + v.activeStake, 0);

    const mean = totalActive / activeVals.length;
    const median = stakes[Math.floor(stakes.length / 2)] || 0;

    result.accounts[key] = {
      ...config,
      totalAccounts: stakeAccounts.length,
      emptyAccounts: totalEmpty,
      totalActive,
      totalDeactivating,
      activeValidators: activeVals.length,
      decentralization: {
        nakamotoCoeff33: nak33, hhi, gini,
        topValidatorPct: stakes[0] ? (stakes[0] / totalActive * 100) : 0,
        top10Pct: stakes.slice(0, 10).reduce((s, v) => s + v, 0) / totalActive * 100,
      },
      stakeStats: {
        mean, median,
        max: stakes[0] || 0, min: stakes[stakes.length - 1] || 0,
        p10: stakes[Math.floor(n * 0.1)] || 0,
        p90: stakes[Math.floor(n * 0.9)] || 0,
      },
      stakeBuckets: buckets,
      geographic: {
        countries: sortObj(countries),
        topCities: sortObj(cities).slice(0, 20),
        topASNs: sortObj(asns).slice(0, 20),
      },
      software: {
        versions: sortObj(versions),
      },
      commissionDistribution: sortObj(commissions),
      jitoStats: {
        validators: jitoVals.length,
        stake: jitoStake,
        pct: (jitoStake / totalActive * 100).toFixed(2),
      },
      delinquentCount: enriched.filter(v => v.delinquent && v.activeStake > 0).length,
      validators: enriched,
    };

    console.log(`  Active: ${totalActive.toFixed(0)} SOL, ${activeVals.length} validators`);
    console.log(`  Nakamoto: ${nak33}, HHI: ${hhi.toFixed(6)}, Gini: ${gini.toFixed(4)}`);
    console.log(`  Countries: ${Object.keys(countries).length}, ASNs: ${Object.keys(asns).length}`);
    console.log(`  Jito: ${jitoVals.length} validators (${(jitoStake/totalActive*100).toFixed(1)}%)`);
  }

  // Combined
  const allVals = {};
  for (const [key, data] of Object.entries(result.accounts)) {
    for (const v of data.validators) {
      if (!allVals[v.voter]) allVals[v.voter] = { voter: v.voter, totalStake: 0, sources: {}, name: v.name, country: v.country, asn: v.asnOrg, commission: v.commission, version: v.version, isJito: v.isJito };
      allVals[v.voter].totalStake += v.activeStake;
      allVals[v.voter].sources[key] = v.activeStake;
    }
  }
  const combinedTotal = Object.values(allVals).reduce((s, v) => s + v.totalStake, 0);
  const combinedSorted = Object.values(allVals).sort((a, b) => b.totalStake - a.totalStake);
  let cNak = 0, cRun = 0;
  for (const v of combinedSorted) { cRun += v.totalStake; cNak++; if (cRun >= combinedTotal / 3) break; }

  // Infrastructure concentration (ASN-level)
  const combinedASNs = {};
  for (const v of combinedSorted) {
    const a = v.asn || 'Unknown';
    if (!combinedASNs[a]) combinedASNs[a] = { name: a, count: 0, stake: 0 };
    combinedASNs[a].count++;
    combinedASNs[a].stake += v.totalStake;
  }
  const asnSorted = Object.values(combinedASNs).sort((a, b) => b.stake - a.stake);
  // Top 3 ASN concentration
  const top3ASNStake = asnSorted.slice(0, 3).reduce((s, a) => s + a.stake, 0);

  // Commission compliance
  const allCombinedVals = combinedSorted.filter(v => v.totalStake > 0);
  const highCommission = allCombinedVals.filter(v => v.commission > 10);
  const jitoOverCap = []; // validators with jito commission > 10% (1000 bps)
  for (const [key, data] of Object.entries(result.accounts)) {
    for (const v of data.validators) {
      if (v.isJito && v.jitoCommission > 1000 && v.activeStake > 0) {
        jitoOverCap.push({ voter: v.voter, name: v.name, jitoCommission: v.jitoCommission, stake: v.activeStake });
      }
    }
  }

  // Foundation stake as % of network
  let totalNetworkStake = 0;
  const seenVoters = new Set();
  for (const [key, data] of Object.entries(result.accounts)) {
    for (const v of data.validators) {
      if (!seenVoters.has(v.voter) && v.totalNetworkStake > 0) {
        totalNetworkStake += v.totalNetworkStake;
        seenVoters.add(v.voter);
      }
    }
  }

  // Validator economics
  const medianStake = result.accounts.mpa4.stakeStats.median;
  const estAnnualRewardSOL = medianStake * 0.065; // ~6.5% APY

  result.combined = {
    totalActiveStake: combinedTotal,
    uniqueValidators: combinedSorted.length,
    nakamotoCoeff33: cNak,
    topValidators: combinedSorted.slice(0, 50).map(v => ({
      ...v, pctOfTotal: (v.totalStake / combinedTotal * 100).toFixed(2),
    })),
    infraConcentration: {
      topASNs: asnSorted.slice(0, 15).map(a => ({
        ...a, pct: (a.stake / combinedTotal * 100).toFixed(2),
      })),
      top3ASNPct: (top3ASNStake / combinedTotal * 100).toFixed(1),
      uniqueASNs: asnSorted.length,
    },
    commissionCompliance: {
      highCommissionCount: highCommission.length,
      highCommission: highCommission.map(v => ({ voter: v.voter, name: v.name, commission: v.commission, stake: v.totalStake })),
      jitoOverCapCount: jitoOverCap.length,
      jitoOverCap,
    },
    foundationVsNetwork: {
      sfdpStake: combinedTotal,
      trackedNetworkStake: totalNetworkStake,
      sfdpPctOfTracked: totalNetworkStake > 0 ? (combinedTotal / totalNetworkStake * 100).toFixed(1) : null,
    },
    validatorEconomics: {
      medianStakeSOL: medianStake,
      estAnnualRewardSOL: estAnnualRewardSOL,
      validatorsInProgram: combinedSorted.filter(v => v.totalStake > 0).length,
    },
  };

  fs.writeFileSync(path.join(DATA_DIR, "latest.json"), JSON.stringify(result, null, 2));
  fs.writeFileSync(path.join(DATA_DIR, `snapshot-${epochInfo.epoch}.json`), JSON.stringify(result, null, 2));
  console.log("\nSaved to data/latest.json");
}

main().catch(e => { console.error(e); process.exit(1); });
