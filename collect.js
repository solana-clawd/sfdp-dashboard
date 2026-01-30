// Collects SFDP staking data and outputs JSON for the dashboard
const fs = require("fs");
const path = require("path");

const RPC = "https://api.mainnet-beta.solana.com";
const DATA_DIR = path.join(__dirname, "data");

const ACCOUNTS = {
  firep: {
    authority: "FiRep26iRQbMaKbqhhs5CqXqy7YrHn462LbnQhXzB2ps",
    label: "SFDP Main (FiRep)",
  },
  mpa4: {
    authority: "mpa4abUkjQoAvPzREkh5Mo75hZhPFQ2FSH6w7dWKuQ5",
    label: "SFDP Matching/Residual (mpa4)",
  },
};

async function rpcCall(method, params) {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const data = await res.json();
  if (data.error) throw new Error(`RPC error: ${JSON.stringify(data.error)}`);
  return data.result;
}

async function getEpochInfo() {
  return rpcCall("getEpochInfo", []);
}

async function getStakeAccountsByAuthority(authority) {
  return rpcCall("getProgramAccounts", [
    "Stake11111111111111111111111111111111111111",
    {
      encoding: "jsonParsed",
      filters: [{ memcmp: { offset: 12, bytes: authority } }],
    },
  ]);
}

function analyzeStakeAccounts(accounts) {
  let totalActive = 0;
  let totalDeactivating = 0;
  let totalEmpty = 0;
  const validators = {};
  const stakeDistribution = [];

  for (const acct of accounts) {
    const parsed = acct.account?.data?.parsed?.info;
    const del = parsed?.stake?.delegation;

    if (!del) {
      totalEmpty++;
      continue;
    }

    const stake = parseInt(del.stake) / 1e9;
    const voter = del.voter;
    const deactivating = del.deactivationEpoch !== "18446744073709551615";
    const activationEpoch = parseInt(del.activationEpoch);

    if (deactivating) {
      totalDeactivating += stake;
    } else {
      totalActive += stake;
    }

    if (!validators[voter]) {
      validators[voter] = {
        voter,
        stakeAccounts: 0,
        totalStake: 0,
        activeStake: 0,
        deactivatingStake: 0,
        activationEpochs: [],
      };
    }
    validators[voter].stakeAccounts++;
    validators[voter].totalStake += stake;
    if (deactivating) validators[voter].deactivatingStake += stake;
    else validators[voter].activeStake += stake;
    validators[voter].activationEpochs.push(activationEpoch);
  }

  // Sort validators by active stake
  const sortedValidators = Object.values(validators).sort(
    (a, b) => b.activeStake - a.activeStake
  );

  // Decentralization metrics
  const activeValidators = sortedValidators.filter((v) => v.activeStake > 0);
  const activeStakes = activeValidators.map((v) => v.activeStake);

  // Nakamoto coefficient (33% threshold)
  let running = 0;
  let nakamoto33 = 0;
  for (const s of activeStakes) {
    running += s;
    nakamoto33++;
    if (running >= totalActive / 3) break;
  }

  // Superminority (33%)
  running = 0;
  let superminority = 0;
  for (const s of activeStakes) {
    running += s;
    superminority++;
    if (running >= totalActive * 0.33) break;
  }

  // HHI (Herfindahl-Hirschman Index)
  let hhi = 0;
  for (const s of activeStakes) {
    const share = s / totalActive;
    hhi += share * share;
  }

  // Gini coefficient
  const n = activeStakes.length;
  const sortedAsc = [...activeStakes].sort((a, b) => a - b);
  let giniSum = 0;
  for (let i = 0; i < n; i++) {
    giniSum += (2 * (i + 1) - n - 1) * sortedAsc[i];
  }
  const gini = n > 0 ? giniSum / (n * sortedAsc.reduce((a, b) => a + b, 0)) : 0;

  // Stake buckets
  const buckets = [
    { label: "<1K SOL", min: 0, max: 1000, count: 0, stake: 0 },
    { label: "1K-10K", min: 1000, max: 10000, count: 0, stake: 0 },
    { label: "10K-50K", min: 10000, max: 50000, count: 0, stake: 0 },
    { label: "50K-100K", min: 50000, max: 100000, count: 0, stake: 0 },
    { label: "100K-500K", min: 100000, max: 500000, count: 0, stake: 0 },
    { label: "500K+", min: 500000, max: Infinity, count: 0, stake: 0 },
  ];
  for (const v of activeValidators) {
    for (const b of buckets) {
      if (v.activeStake >= b.min && v.activeStake < b.max) {
        b.count++;
        b.stake += v.activeStake;
        break;
      }
    }
  }

  // Stats
  const mean = totalActive / activeValidators.length;
  const median = activeStakes[Math.floor(activeStakes.length / 2)] || 0;
  const max = activeStakes[0] || 0;
  const min = activeStakes[activeStakes.length - 1] || 0;
  const p10 = activeStakes[Math.floor(activeStakes.length * 0.1)] || 0;
  const p90 = activeStakes[Math.floor(activeStakes.length * 0.9)] || 0;

  return {
    totalAccounts: accounts.length,
    emptyAccounts: totalEmpty,
    totalActive,
    totalDeactivating,
    uniqueValidators: Object.keys(validators).length,
    activeValidators: activeValidators.length,
    decentralization: {
      nakamotoCoeff33: nakamoto33,
      superminorityCount: superminority,
      hhi,
      gini,
    },
    stakeStats: { mean, median, max, min, p10, p90 },
    stakeBuckets: buckets,
    topValidators: sortedValidators.slice(0, 25).map((v) => ({
      voter: v.voter,
      activeStake: v.activeStake,
      deactivatingStake: v.deactivatingStake,
      stakeAccounts: v.stakeAccounts,
      pctOfTotal: ((v.activeStake / totalActive) * 100).toFixed(2),
    })),
    allValidators: sortedValidators.map((v) => ({
      voter: v.voter,
      activeStake: v.activeStake,
      deactivatingStake: v.deactivatingStake,
      stakeAccounts: v.stakeAccounts,
    })),
  };
}

async function collect() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

  const epochInfo = await getEpochInfo();
  console.log(`Epoch: ${epochInfo.epoch}, Slot: ${epochInfo.absoluteSlot}`);

  const result = {
    timestamp: new Date().toISOString(),
    epoch: epochInfo.epoch,
    slot: epochInfo.absoluteSlot,
    epochPct: ((epochInfo.slotIndex / epochInfo.slotsInEpoch) * 100).toFixed(2),
    accounts: {},
  };

  for (const [key, config] of Object.entries(ACCOUNTS)) {
    console.log(`\nCollecting ${config.label}...`);
    const stakeAccounts = await getStakeAccountsByAuthority(config.authority);
    console.log(`  Found ${stakeAccounts.length} stake accounts`);
    const analysis = analyzeStakeAccounts(stakeAccounts);
    result.accounts[key] = {
      ...config,
      ...analysis,
    };
    console.log(`  Active: ${analysis.totalActive.toFixed(2)} SOL across ${analysis.activeValidators} validators`);
    console.log(`  Nakamoto: ${analysis.decentralization.nakamotoCoeff33}, HHI: ${analysis.decentralization.hhi.toFixed(6)}, Gini: ${analysis.decentralization.gini.toFixed(4)}`);
  }

  // Combined metrics
  const allValidators = {};
  for (const [key, data] of Object.entries(result.accounts)) {
    for (const v of data.allValidators) {
      if (!allValidators[v.voter]) allValidators[v.voter] = { voter: v.voter, totalStake: 0, sources: {} };
      allValidators[v.voter].totalStake += v.activeStake;
      allValidators[v.voter].sources[key] = v.activeStake;
    }
  }
  const combinedTotal = Object.values(allValidators).reduce((s, v) => s + v.totalStake, 0);
  const combinedSorted = Object.values(allValidators).sort((a, b) => b.totalStake - a.totalStake);

  let combinedNak = 0, combinedRunning = 0;
  for (const v of combinedSorted) {
    combinedRunning += v.totalStake;
    combinedNak++;
    if (combinedRunning >= combinedTotal / 3) break;
  }

  result.combined = {
    totalActiveStake: combinedTotal,
    uniqueValidators: combinedSorted.length,
    nakamotoCoeff33: combinedNak,
    topValidators: combinedSorted.slice(0, 25).map((v) => ({
      voter: v.voter,
      totalStake: v.totalStake,
      sources: v.sources,
      pctOfTotal: ((v.totalStake / combinedTotal) * 100).toFixed(2),
    })),
  };

  const outPath = path.join(DATA_DIR, "latest.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2));
  console.log(`\nData saved to ${outPath}`);

  // Also save historical snapshot
  const histPath = path.join(DATA_DIR, `snapshot-${epochInfo.epoch}.json`);
  if (!fs.existsSync(histPath)) {
    fs.writeFileSync(histPath, JSON.stringify(result, null, 2));
    console.log(`Historical snapshot saved to ${histPath}`);
  }

  return result;
}

collect().catch((e) => {
  console.error("Error:", e);
  process.exit(1);
});
