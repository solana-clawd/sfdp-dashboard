// Collects full Solana network validator + stake decentralization data
const fs = require("fs");
const path = require("path");

const RPC = process.env.HELIUS_RPC || "https://api.mainnet-beta.solana.com";
const DATA_DIR = path.join(__dirname, "data");

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(JSON.stringify(data.error));
  return data.result;
}

async function main() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const epochInfo = await rpc("getEpochInfo", []);
  console.log(`Epoch ${epochInfo.epoch} (${((epochInfo.slotIndex/epochInfo.slotsInEpoch)*100).toFixed(1)}%)`);

  // Vote accounts
  console.log("Fetching vote accounts...");
  const va = await rpc("getVoteAccounts", [{ commitment: "confirmed" }]);
  const current = va.current || [];
  const delinquent = va.delinquent || [];
  console.log(`  Current: ${current.length}, Delinquent: ${delinquent.length}`);

  // Stakewiz metadata
  console.log("Fetching stakewiz metadata...");
  const sw = await (await fetch("https://api.stakewiz.com/validators")).json();
  const swMap = {};
  for (const v of sw) swMap[v.vote_identity] = v;

  // Block production
  console.log("Fetching block production...");
  const bp = await rpc("getBlockProduction", [{ commitment: "confirmed" }]);
  const bpMap = {};
  for (const [id, [slots, blocks]] of Object.entries(bp.value?.byIdentity || {})) {
    bpMap[id] = { leaderSlots: slots, blocksProduced: blocks, skipRate: slots > 0 ? ((slots - blocks) / slots * 100) : 0 };
  }

  // Build validator list
  const allVals = [];
  let totalStake = 0;

  for (const v of [...current, ...delinquent]) {
    const stake = v.activatedStake / 1e9;
    totalStake += stake;
    const m = swMap[v.votePubkey] || {};
    const bpd = bpMap[m.identity] || {};

    allVals.push({
      voter: v.votePubkey,
      name: m.name || null,
      identity: m.identity || null,
      stake,
      commission: v.commission,
      delinquent: delinquent.includes(v),
      version: m.version || null,
      country: m.ip_country || null,
      city: m.ip_city || null,
      asn: m.ip_asn || null,
      asnOrg: m.ip_org || null,
      isJito: m.is_jito || false,
      jitoCommission: m.jito_commission_bps || null,
      skipRate: m.wiz_skip_rate ?? bpd.skipRate ?? null,
      leaderSlots: bpd.leaderSlots || null,
      blocksProduced: bpd.blocksProduced || null,
      wizScore: m.wiz_score || null,
      apy: m.total_apy || m.apy_estimate || null,
      superminority: m.superminority_penalty > 0,
      stakeWeight: m.stake_weight || null,
    });
  }

  allVals.sort((a, b) => b.stake - a.stake);
  console.log(`Total network stake: ${(totalStake/1e6).toFixed(2)}M SOL across ${allVals.length} validators`);

  // Decentralization metrics
  const stakes = allVals.map(v => v.stake);

  // Nakamoto 33%
  let running = 0, nak33 = 0;
  for (const s of stakes) { running += s; nak33++; if (running >= totalStake / 3) break; }

  // Superminority (33% halt line)
  running = 0; let superminority = 0;
  for (const s of stakes) { running += s; superminority++; if (running >= totalStake * 0.33) break; }

  // HHI
  let hhi = 0;
  stakes.forEach(s => { const sh = s / totalStake; hhi += sh * sh; });

  // Gini
  const n = stakes.length;
  const asc = [...stakes].sort((a, b) => a - b);
  let giniSum = 0;
  for (let i = 0; i < n; i++) giniSum += (2 * (i + 1) - n - 1) * asc[i];
  const gini = n > 0 ? giniSum / (n * asc.reduce((a, b) => a + b, 0)) : 0;

  // Top concentration
  const top10Stake = stakes.slice(0, 10).reduce((s, v) => s + v, 0);
  const top20Stake = stakes.slice(0, 20).reduce((s, v) => s + v, 0);
  const top50Stake = stakes.slice(0, 50).reduce((s, v) => s + v, 0);

  // Geographic
  const countries = {}, cities = {}, asns = {}, versions = {}, commissions = {};
  const helpers = { countries, cities, asns, versions, commissions };
  for (const v of allVals) {
    const c = v.country || "Unknown";
    const ci = v.city || "Unknown";
    const a = v.asnOrg || v.asn || "Unknown";
    const ver = v.version || "Unknown";
    const com = v.commission != null ? String(v.commission) : "Unknown";

    for (const [key, field, val] of [["countries",c,c],["cities",ci,ci],["asns",a,a],["versions",ver,ver],["commissions",com,com]]) {
      if (!helpers[key][val]) helpers[key][val] = { count: 0, stake: 0 };
      helpers[key][val].count++;
      helpers[key][val].stake += v.stake;
    }
  }

  const sortObj = (obj) => Object.entries(obj)
    .map(([k, v]) => ({ name: k, ...v, pct: (v.stake / totalStake * 100).toFixed(2) }))
    .sort((a, b) => b.stake - a.stake);

  // Continents
  const COUNTRY_CONTINENT = {
    'United States':'North America','Canada':'North America','Mexico':'North America',
    'Brazil':'South America','Argentina':'South America','Chile':'South America','Colombia':'South America','Peru':'South America',
    'Germany':'Europe','Netherlands':'Europe','France':'Europe','United Kingdom':'Europe','Ireland':'Europe',
    'Sweden':'Europe','Norway':'Europe','Poland':'Europe','Ukraine':'Europe','Romania':'Europe','Spain':'Europe',
    'Austria':'Europe','Bulgaria':'Europe','Czech Republic':'Europe','Estonia':'Europe','Latvia':'Europe',
    'Luxembourg':'Europe','Russia':'Europe','Republic of Lithuania':'Europe','Slovak Republic':'Europe',
    'Finland':'Europe','Denmark':'Europe','Belgium':'Europe','Portugal':'Europe','Italy':'Europe',
    'Switzerland':'Europe','Lithuania':'Europe','Turkey':'Europe',
    'Japan':'Asia','Singapore':'Asia','Hong Kong':'Asia','South Korea':'Asia','India':'Asia',
    'Thailand':'Asia','Indonesia':'Asia','Taiwan':'Asia','Philippines':'Asia','Vietnam':'Asia','Israel':'Asia',
    'South Africa':'Africa','Australia':'Oceania','New Zealand':'Oceania',
  };
  const continents = {};
  for (const v of allVals) {
    const cont = COUNTRY_CONTINENT[v.country] || "Other";
    if (!continents[cont]) continents[cont] = { count: 0, stake: 0 };
    continents[cont].count++;
    continents[cont].stake += v.stake;
  }

  // Stake buckets
  const buckets = [
    { label: "<10K", min: 0, max: 10000, count: 0, stake: 0 },
    { label: "10K-50K", min: 10000, max: 50000, count: 0, stake: 0 },
    { label: "50K-100K", min: 50000, max: 100000, count: 0, stake: 0 },
    { label: "100K-500K", min: 100000, max: 500000, count: 0, stake: 0 },
    { label: "500K-1M", min: 500000, max: 1000000, count: 0, stake: 0 },
    { label: "1M-5M", min: 1000000, max: 5000000, count: 0, stake: 0 },
    { label: "5M+", min: 5000000, max: Infinity, count: 0, stake: 0 },
  ];
  for (const v of allVals) {
    for (const b of buckets) {
      if (v.stake >= b.min && v.stake < b.max) { b.count++; b.stake += v.stake; break; }
    }
  }

  // Jito
  const jitoVals = allVals.filter(v => v.isJito);
  const jitoStake = jitoVals.reduce((s, v) => s + v.stake, 0);

  // Superminority validators
  running = 0;
  const superminorityVals = [];
  for (const v of allVals) {
    running += v.stake;
    superminorityVals.push(v.voter);
    if (running >= totalStake * 0.33) break;
  }

  const mean = totalStake / allVals.length;
  const median = stakes[Math.floor(stakes.length / 2)] || 0;

  // Top 3 ASN
  const asnSorted = sortObj(asns);
  const top3ASNStake = asnSorted.slice(0, 3).reduce((s, a) => s + a.stake, 0);

  const result = {
    timestamp: new Date().toISOString(),
    epoch: epochInfo.epoch,
    slot: epochInfo.absoluteSlot,
    epochPct: ((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2),
    totalStake,
    totalValidators: allVals.length,
    currentValidators: current.length,
    delinquentValidators: delinquent.length,
    decentralization: {
      nakamotoCoeff33: nak33,
      superminorityCount: superminority,
      hhi,
      gini,
      topValidatorPct: (stakes[0] / totalStake * 100),
      top10Pct: (top10Stake / totalStake * 100),
      top20Pct: (top20Stake / totalStake * 100),
      top50Pct: (top50Stake / totalStake * 100),
    },
    stakeStats: { mean, median, max: stakes[0], min: stakes[stakes.length - 1], p10: stakes[Math.floor(n * 0.1)], p90: stakes[Math.floor(n * 0.9)] },
    stakeBuckets: buckets,
    geographic: {
      countries: sortObj(countries).slice(0, 30),
      continents: sortObj(continents),
      topCities: sortObj(cities).slice(0, 30),
      topASNs: asnSorted.slice(0, 30),
    },
    infraConcentration: {
      top3ASNPct: (top3ASNStake / totalStake * 100).toFixed(1),
      uniqueASNs: Object.keys(asns).length,
      uniqueCountries: Object.keys(countries).length,
      uniqueCities: Object.keys(cities).length,
    },
    software: { versions: sortObj(versions) },
    commissionDistribution: sortObj(commissions),
    jitoStats: {
      validators: jitoVals.length,
      stake: jitoStake,
      pct: (jitoStake / totalStake * 100).toFixed(2),
    },
    superminorityVoters: superminorityVals,
    validators: allVals.map(v => ({
      ...v,
      pctOfTotal: (v.stake / totalStake * 100).toFixed(4),
      isSuperminority: superminorityVals.includes(v.voter),
    })),
  };

  const outPath = path.join(DATA_DIR, "network-latest.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nSaved to ${outPath}`);
  console.log(`Nakamoto: ${nak33}, HHI: ${hhi.toFixed(6)}, Gini: ${gini.toFixed(4)}`);
  console.log(`Countries: ${Object.keys(countries).length}, ASNs: ${Object.keys(asns).length}`);
  console.log(`Jito: ${jitoVals.length} (${(jitoStake/totalStake*100).toFixed(1)}%)`);
  console.log(`Top 3 ASN: ${top3ASNStake.toFixed(0)} SOL (${(top3ASNStake/totalStake*100).toFixed(1)}%)`);
}

main().catch(e => { console.error(e); process.exit(1); });
