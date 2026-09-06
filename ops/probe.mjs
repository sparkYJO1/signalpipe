#!/usr/bin/env node
/**
 * The release probe.
 *
 * Fires steady, open-loop traffic at the API, runs a real deploy in the middle
 * of it, and reports what the deploy cost: failed requests, latency
 * percentiles, and how long the rollout took.
 *
 * Open-loop matters. A closed-loop client (N workers each waiting for a reply)
 * stops sending when the server stalls, so a stall shows up as lower throughput
 * instead of higher latency and the tail you wanted to measure disappears. This
 * schedules on a wall clock and lets requests overlap.
 *
 * Exit code is the assertion: non-zero if any request failed.
 *
 *   node ops/probe.mjs --url http://localhost:8080 \
 *     --deploy "helm upgrade --install signalpipe deploy/helm/signalpipe ..."
 */
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[key] = true;
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const cfg = {
  url: args.url ?? "http://localhost:8080",
  path: args.path ?? "/check",
  method: (args.method ?? "POST").toUpperCase(),
  rps: Number(args.rps ?? 40),
  warmup: Number(args.warmup ?? 5),
  cooldown: Number(args.cooldown ?? 10),
  timeout: Number(args.timeout ?? 5000),
  maxSeconds: Number(args["max-seconds"] ?? 420),
  deploy: typeof args.deploy === "string" ? args.deploy : null,
  label: args.label ?? "rolling deploy",
  out: typeof args.out === "string" ? args.out : null,
  json: typeof args.json === "string" ? args.json : null,
};

const BODY = JSON.stringify({
  dependencies: [
    { ecosystem: "npm", name: "lodash", version: "4.17.20" },
    { ecosystem: "npm", name: "minimist", version: "1.2.5" },
    { ecosystem: "npm", name: "tar", version: "6.2.0" },
  ],
});

const target = new URL(cfg.path, cfg.url);
const client = target.protocol === "https:" ? https : http;
const agent = new client.Agent({
  keepAlive: true,
  maxSockets: Math.max(16, cfg.rps),
  maxFreeSockets: Math.max(16, cfg.rps),
});

/** phase: "warmup" | "deploy" | "cooldown" */
let phase = "warmup";
const samples = [];
let inFlight = 0;

function fire() {
  const startedAt = Date.now();
  const startPhase = phase;
  inFlight++;

  const req = client.request(
    {
      agent,
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: target.pathname + target.search,
      method: cfg.method,
      headers:
        cfg.method === "GET"
          ? { accept: "application/json" }
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(BODY),
            },
    },
    (res) => {
      res.resume();
      res.on("end", () => {
        inFlight--;
        samples.push({
          ms: Date.now() - startedAt,
          status: res.statusCode,
          phase: startPhase,
          err: null,
        });
      });
    },
  );

  req.setTimeout(cfg.timeout, () => {
    req.destroy(new Error("ETIMEDOUT"));
  });

  req.on("error", (err) => {
    inFlight--;
    samples.push({
      ms: Date.now() - startedAt,
      status: 0,
      phase: startPhase,
      err: err.code || err.message,
    });
  });

  if (cfg.method !== "GET") req.write(BODY);
  req.end();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pct(sorted, p) {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[i];
}

function summarise(rows) {
  const lat = rows.map((r) => r.ms).sort((a, b) => a - b);
  const failures = rows.filter((r) => r.err !== null || r.status >= 500);
  const byReason = {};
  for (const f of failures) {
    const k = f.err ?? `HTTP ${f.status}`;
    byReason[k] = (byReason[k] ?? 0) + 1;
  }
  return {
    n: rows.length,
    ok: rows.length - failures.length,
    failed: failures.length,
    byReason,
    p50: pct(lat, 50),
    p95: pct(lat, 95),
    p99: pct(lat, 99),
    max: lat[lat.length - 1] ?? 0,
  };
}

function pad(s, n) {
  s = String(s);
  return s + " ".repeat(Math.max(0, n - s.length));
}
function rpad(s, n) {
  s = String(s);
  return " ".repeat(Math.max(0, n - s.length)) + s;
}

async function runDeploy(cmd) {
  const t0 = Date.now();
  const child = spawn(cmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
  const log = [];
  child.stdout.on("data", (d) => log.push(d.toString()));
  child.stderr.on("data", (d) => log.push(d.toString()));
  const code = await new Promise((resolve) => child.on("close", resolve));
  return { ms: Date.now() - t0, code, log: log.join("") };
}

async function main() {
  console.log(
    `probe → ${cfg.method} ${target.href}  rps=${cfg.rps}  warmup=${cfg.warmup}s cooldown=${cfg.cooldown}s`,
  );

  const interval = 1000 / cfg.rps;
  const ticker = setInterval(fire, interval);
  const hardStop = setTimeout(() => {
    clearInterval(ticker);
  }, cfg.maxSeconds * 1000);

  await sleep(cfg.warmup * 1000);

  phase = "deploy";
  const deployStart = Date.now();
  let deploy = { ms: 0, code: 0, log: "(no --deploy given)" };
  if (cfg.deploy) {
    console.log(`deploy → ${cfg.deploy}`);
    deploy = await runDeploy(cfg.deploy);
  }
  const deployEnd = Date.now();

  phase = "cooldown";
  await sleep(cfg.cooldown * 1000);

  clearInterval(ticker);
  clearTimeout(hardStop);

  // Let anything still in flight land before we score it.
  const drainDeadline = Date.now() + cfg.timeout + 1000;
  while (inFlight > 0 && Date.now() < drainDeadline) await sleep(50);
  agent.destroy();

  const all = summarise(samples);
  const during = summarise(samples.filter((r) => r.phase === "deploy"));
  const before = summarise(samples.filter((r) => r.phase === "warmup"));
  const after = summarise(samples.filter((r) => r.phase === "cooldown"));

  const rows = [
    ["before deploy", before],
    ["during deploy", during],
    ["after deploy", after],
    ["total", all],
  ];

  const lines = [];
  lines.push("");
  lines.push(
    `${pad("window", 14)} ${rpad("requests", 9)} ${rpad("failed", 7)} ${rpad("p50", 7)} ${rpad("p95", 7)} ${rpad("p99", 7)} ${rpad("max", 7)}`,
  );
  lines.push("-".repeat(14 + 1 + 9 + 1 + 7 * 4 + 4));
  for (const [name, s] of rows) {
    lines.push(
      `${pad(name, 14)} ${rpad(s.n, 9)} ${rpad(s.failed, 7)} ${rpad(s.p50 + "ms", 7)} ${rpad(s.p95 + "ms", 7)} ${rpad(s.p99 + "ms", 7)} ${rpad(s.max + "ms", 7)}`,
    );
  }
  lines.push("");
  lines.push(
    `${cfg.label}: ${(deploy.ms / 1000).toFixed(1)}s   exit=${deploy.code}   offered load ${cfg.rps}/s`,
  );
  if (all.failed > 0) {
    lines.push(
      `failures: ${Object.entries(all.byReason)
        .map(([k, v]) => `${k} ×${v}`)
        .join(", ")}`,
    );
  } else {
    lines.push("failures: none — 0 non-2xx, 0 connection errors, 0 timeouts");
  }
  lines.push("");

  const text = lines.join("\n");
  console.log(text);
  if (deploy.code !== 0) {
    console.error("deploy command failed:\n" + deploy.log.slice(-4000));
  }

  if (cfg.out) writeFileSync(cfg.out, text);
  if (cfg.json)
    writeFileSync(
      cfg.json,
      JSON.stringify(
        {
          cfg,
          deployMs: deploy.ms,
          deployExit: deploy.code,
          windows: { before, during, after, total: all },
          deployStart,
          deployEnd,
        },
        null,
        2,
      ),
    );

  // The assertion. A deploy that dropped a request is a failed deploy.
  if (all.failed > 0 || deploy.code !== 0) process.exit(1);
  process.exit(0);
}

main().catch((err) => {
  console.error("probe failed:", err);
  process.exit(2);
});
