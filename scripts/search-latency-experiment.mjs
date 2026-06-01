import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { performance } from "node:perf_hooks";

const DEFAULT_PROJECT = "feishu-route";
const CUSTOMER_COUNT = 10000;
const CUSTOMER_SAMPLE_SIZE = 30;
const COWORKER_CACHE_QUERIES = [
  "ali",
  "alice",
  "bob",
  "carl",
  "diana",
  "ed",
  "fiona",
  "george",
  "harry",
  "iris",
  "julia",
];

function usage() {
  return [
    "Usage: bun scripts/search-latency-experiment.mjs [--project feishu-route] [--deployment dev] [--customer-count 10000] [--customer-queries 30] --destructive-ok [--cleanup]",
    "",
    "Notes:",
    "- Defaults are tuned for a stress run on project 'feishu-route' in dev deployment.",
    "- Requires Convex CLI auth in this environment (bunx convex must be logged in).",
    "- Script writes mock data to customers/coworkerSearchCache/feishuUserTokens via convex import --replace and then executes repeated convex run calls.",
    "- Requires --destructive-ok so it cannot run accidentally against a real environment.",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    project: DEFAULT_PROJECT,
    deployment: "dev",
    customerCount: CUSTOMER_COUNT,
    customerQueries: CUSTOMER_SAMPLE_SIZE,
    cleanup: false,
    destructiveOk: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--project") {
      out.project = argv[++i] ?? out.project;
      continue;
    }
    if (arg === "--deployment") {
      out.deployment = argv[++i] ?? out.deployment;
      continue;
    }
    if (arg === "--customer-count") {
      out.customerCount = Number.parseInt(argv[++i] ?? String(CUSTOMER_COUNT), 10);
      continue;
    }
    if (arg === "--customer-queries") {
      out.customerQueries = Number.parseInt(argv[++i] ?? String(CUSTOMER_SAMPLE_SIZE), 10);
      continue;
    }
    if (arg === "--cleanup") {
      out.cleanup = true;
      continue;
    }
    if (arg === "--destructive-ok") {
      out.destructiveOk = true;
      continue;
    }
    if (arg === "-h" || arg === "--help") {
      console.log(usage());
      process.exit(0);
    }
  }

  if (Number.isNaN(out.customerCount) || out.customerCount <= 0) {
    throw new Error("--customer-count must be a positive integer");
  }
  if (Number.isNaN(out.customerQueries) || out.customerQueries <= 0) {
    throw new Error("--customer-queries must be a positive integer");
  }
  if (!out.destructiveOk) {
    throw new Error(
      "Refusing to replace Convex tables without --destructive-ok. Run only against a disposable/dev deployment.",
    );
  }
  return out;
}

function runConvex(args, deploymentRef) {
  const started = performance.now();
  const res = spawnSync("bunx", ["convex", ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  const elapsedMs = Math.round(performance.now() - started);
  if (res.status !== 0) {
    const err = (res.stderr ?? "").trim();
    if (err.includes("No CONVEX_DEPLOYMENT set") || err.includes("InvalidDeploymentName")) {
      throw new Error(
        `convex ${args[0]} failed in ${elapsedMs}ms: ${err}\n` +
          "Set deployment context before running this script. In an interactive session:\n" +
          "  bunx convex dev             # initialize/link this project\n" +
          "  bunx convex deployment select feishu-route:dev\n" +
          "Or set CONVEX_DEPLOYMENT explicitly to a fully-qualified deployment ref.\n" +
          `Expected format here is \"${deploymentRef}\".`,
      );
    }
    throw new Error(`convex ${args[0]} failed in ${elapsedMs}ms:\n${err}`);
  }

  return {
    stdout: (res.stdout ?? "").trim(),
    elapsedMs,
  };
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[index];
}

function buildMockCustomers(count, seed = Date.now()) {
  const rows = [];
  for (let i = 1; i <= count; i += 1) {
    rows.push({
      recordId: `bench_customer_${i}`,
      name: `Customer ${i}`,
      domain: `customer${i}.example.com`,
      fullName: `Customer ${i} Example Full Name`,
      accountNo: `ACCT-${i}`,
      countryRegion: i % 2 === 0 ? "Germany" : "United Kingdom",
      ownerOpenId: i % 10 === 0 ? "ou_owner_10" : undefined,
      ownerName: i % 10 === 0 ? "Benchmark Owner" : undefined,
      searchBlob: `customer ${i} customer${i} customer${i}.example.com acme example`,
      mirroredAt: seed + i,
    });
  }
  return rows;
}

function buildCoworkerCacheRows(nowMs) {
  const byQuery = [...COWORKER_CACHE_QUERIES, "alice", "alibaba", "alex", "alvin", "ally"];
  return byQuery.map((query, queryIndex) => ({
    sessionId: "bench_session_01",
    query,
    results: Array.from({ length: 8 }, (_, resultIndex) => ({
      openId: `ou_${queryIndex}_${resultIndex}`,
      name: `${query} Contact ${resultIndex}`,
      avatarUrl: `https://cdn.example.com/avatars/${query}_${resultIndex}.png`,
    })),
    cachedAt: nowMs - queryIndex * 1000,
    ttlMs: 5 * 60 * 1000,
  }));
}

function runExperiment(config) {
  const deploymentRef = config.project.includes(":") ? config.project : `${config.project}:${config.deployment}`;
  const tempRoot = mkdtempSync(join(tmpdir(), "feishu-search-experiment-"));
  const customerFile = join(tempRoot, "customers.json");
  const cacheFile = join(tempRoot, "coworker-cache.json");
  const userTokenFile = join(tempRoot, "feishu-user-tokens.json");

  const mockNow = Date.now();
  const customerRows = buildMockCustomers(config.customerCount, mockNow);
  const cacheRows = buildCoworkerCacheRows(mockNow);
  const tokenRows = [
    {
      sessionId: "bench_session_01",
      accessToken: "__bench_access_token__",
      refreshToken: "__bench_refresh_token__",
      expiresAt: mockNow + 60 * 60 * 1000,
      tokenType: "Bearer",
      openId: "ou_bench_user",
      userName: "Benchmark User",
    },
  ];
  writeFileSync(customerFile, `${JSON.stringify(customerRows)}\n`, "utf8");
  writeFileSync(cacheFile, `${JSON.stringify(cacheRows)}\n`, "utf8");
  writeFileSync(userTokenFile, `${JSON.stringify(tokenRows)}\n`, "utf8");

  console.log(`[experiment] using deployment ${deploymentRef}`);
  console.log(
    `[experiment] seeded customers=${customerRows.length}, cacheQueries=${cacheRows.length}, ` +
      `feishuUserTokens=${tokenRows.length}`,
  );

  console.log("Importing mock customers into `customers` table...");
  runConvex(["import", "--table", "customers", "--replace", "--yes", "--deployment", deploymentRef, customerFile], deploymentRef);

  console.log("Importing mock coworker cache into `coworkerSearchCache` table...");
  runConvex(
    [
      "import",
      "--table",
      "coworkerSearchCache",
      "--replace",
      "--yes",
      "--deployment",
      deploymentRef,
      cacheFile,
    ],
    deploymentRef,
  );

  console.log("Importing mock Feishu user token into `feishuUserTokens` table...");
  runConvex(
    [
      "import",
      "--table",
      "feishuUserTokens",
      "--replace",
      "--yes",
      "--deployment",
      deploymentRef,
      userTokenFile,
    ],
    deploymentRef,
  );

  const customerQueryDurations = [];
  const coworkerQueryDurations = [];
  const customerQueries = Array.from({ length: config.customerQueries }, (_, idx) => {
    const seedIndex = (idx * 17) % config.customerCount;
    return `customer ${seedIndex + 1}`;
  });
  const coworkerQueries = COWORKER_CACHE_QUERIES.map((q) => q);

  console.log("Running customer search query loop...");
  for (const q of customerQueries) {
    const payload = { q, limit: 20 };
    const call = runConvex(
      [
        "run",
        "--deployment",
        deploymentRef,
        "feishu/customersMirror:search",
        JSON.stringify(payload),
      ],
      deploymentRef,
    );
    customerQueryDurations.push(call.elapsedMs);
  }

  console.log("Running coworker search (public query cache-hit) loop...");
  for (const q of coworkerQueries) {
    const payload = {
      sessionId: "bench_session_01",
      query: q,
    };
    const call = runConvex(
      [
        "run",
        "--deployment",
        deploymentRef,
        "feishu/coworkers:searchCoworkersCached",
        JSON.stringify(payload),
      ],
      deploymentRef,
    );
    coworkerQueryDurations.push(call.elapsedMs);
  }

  const customerP50 = percentile(customerQueryDurations, 50);
  const customerP95 = percentile(customerQueryDurations, 95);
  const coworkerP50 = percentile(coworkerQueryDurations, 50);
  const coworkerP95 = percentile(coworkerQueryDurations, 95);

  console.log("=== Stress metrics (CLI wall-time; includes convex CLI overhead) ===");
  console.log(
    JSON.stringify(
      {
        deployment: deploymentRef,
        customer: {
          count: config.customerCount,
          calls: customerQueries.length,
          p50Ms: customerP50,
          p95Ms: customerP95,
          minMs: Math.min(...customerQueryDurations),
          maxMs: Math.max(...customerQueryDurations),
        },
        coworker: {
          calls: coworkerQueries.length,
          p50Ms: coworkerP50,
          p95Ms: coworkerP95,
          minMs: Math.min(...coworkerQueryDurations),
          maxMs: Math.max(...coworkerQueryDurations),
        },
      },
      null,
      2,
    ),
  );

  if (config.cleanup) {
    console.log("Cleanup requested: replacing tables with empty arrays...");
    const empty = join(tempRoot, "empty.json");
    writeFileSync(empty, "[]\n", "utf8");
    runConvex(["import", "--table", "customers", "--replace", "--yes", "--deployment", deploymentRef, empty], deploymentRef);
    runConvex(
      [
        "import",
        "--table",
        "coworkerSearchCache",
        "--replace",
        "--yes",
        "--deployment",
        deploymentRef,
        empty,
      ],
      deploymentRef,
    );
    runConvex(
      [
        "import",
        "--table",
        "feishuUserTokens",
        "--replace",
        "--yes",
        "--deployment",
        deploymentRef,
        empty,
      ],
      deploymentRef,
    );
  }
}

async function main() {
  const config = parseArgs(process.argv.slice(2));
  runExperiment(config);
}

main();
