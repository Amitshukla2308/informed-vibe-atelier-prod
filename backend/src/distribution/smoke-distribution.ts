/**
 * Smoke test for Session 6 — distribution adapters MVP.
 *
 * Run:
 *   cd ~/informed-vibes/active/atelier/backend
 *   bun src/distribution/smoke-distribution.ts
 *
 * Coverage:
 *   1. Registry lookup — listDistributionAdapters() yields 4; getDistributionAdapter() resolves each by id.
 *   2. detectInstalled() returns the documented "API-only" shape (available:false + hint).
 *   3. configSchema rejects bad input (missing required field, too-short token).
 *   4. Mock-write Cloudflare config — file lands at the expected absolute path.
 *   5. DB upsert / read round-trips a full link with secret-redaction in the listed shape.
 *   6. verify() returns ok:false with a non-empty detail when called against a bogus token
 *      (sanity — the path runs end-to-end against the real Cloudflare API and returns auth-failed).
 *
 * No real API tokens are used. The real-API verify call is best-effort:
 *   if there's no network it still passes (we only assert "didn't crash + has detail").
 */

import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { listDistributionAdapters, getDistributionAdapter } from "./index";
import { upsertDistributionLink, getDistributionLink, deleteDistributionLink } from "./links";
import { getDb, newId, nowIso } from "~/db";

let pass = 0;
let fail = 0;
function expect(label: string, ok: boolean, detail?: string) {
  if (ok) { pass++; console.log(`  ✓ ${label}`); }
  else    { fail++; console.log(`  ✗ ${label}${detail ? `  — ${detail}` : ""}`); }
}

async function main() {
  console.log("=== Session 6 distribution adapters smoke ===\n");

  // 1. Registry
  console.log("1. Registry");
  const adapters = listDistributionAdapters();
  expect("listDistributionAdapters() returns 4", adapters.length === 4, `got ${adapters.length}`);
  const ids = adapters.map(a => a.id).sort();
  expect("ids include cloudflare-dns/razorpay/plausible/resend",
    JSON.stringify(ids) === JSON.stringify(["cloudflare-dns", "plausible", "razorpay", "resend"]),
    JSON.stringify(ids));
  for (const id of ["cloudflare-dns", "razorpay", "plausible", "resend"] as const) {
    try {
      const a = getDistributionAdapter(id);
      expect(`getDistributionAdapter("${id}") resolves`, a.id === id);
      expect(`  has category`,    typeof a.category === "string" && a.category.length > 0);
      expect(`  has label`,       typeof a.label === "string" && a.label.length > 0);
      expect(`  has purpose`,     typeof a.purpose === "string" && a.purpose.length > 5);
      expect(`  has configSchema`,!!a.configSchema && typeof a.configSchema.parse === "function");
    } catch (e) {
      expect(`getDistributionAdapter("${id}") resolves`, false, String(e));
    }
  }

  // 2. detectInstalled — the documented Phase A behaviour is available:false + hint for all
  console.log("\n2. detectInstalled (all four are API-only — expecting available:false)");
  for (const a of adapters) {
    const r = await a.detectInstalled();
    expect(`${a.id}.detectInstalled() shape`, typeof r.available === "boolean" && typeof r.hint === "string" && r.hint.length > 0,
      `available=${r.available} hint="${r.hint.slice(0, 60)}"`);
    expect(`${a.id}.detectInstalled() returns false (API-only)`, r.available === false);
  }

  // 3. Schema rejects bad input
  console.log("\n3. configSchema validates input");
  const cf = getDistributionAdapter("cloudflare-dns");
  let rejected = false;
  try { cf.configSchema.parse({ api_token: "x", zone_id: "y", domain: "z" }); }
  catch { rejected = true; }
  expect("cloudflare schema rejects too-short api_token", rejected);

  rejected = false;
  try { cf.configSchema.parse({ api_token: "x".repeat(40), zone_id: "abc12345", domain: "fastbrick.in" }); }
  catch { rejected = true; }
  expect("cloudflare schema accepts a valid-looking config", !rejected);

  // 4. Mock-write Cloudflare config
  console.log("\n4. writeConfig — Cloudflare DNS mock-write");
  const tmpRoot = mkdtempSync(pathResolve(tmpdir(), "atelier-dist-smoke-"));
  try {
    const fakeCfg = {
      api_token: "FAKE_" + "x".repeat(40),
      zone_id: "abcd1234efgh5678",
      domain: "smoke-test.example",
    };
    const result = await cf.writeConfig({
      project: "SmokeProject",
      cwd: tmpRoot,
      config: fakeCfg,
    });
    const machineP = pathResolve(tmpRoot, ".distribution", "cloudflare-dns.json");
    const humanP = pathResolve(tmpRoot, "distribution", "cloudflare-dns.md");
    expect("filesWritten contains machine path", result.filesWritten.includes(machineP), machineP);
    expect("filesWritten contains human path",   result.filesWritten.includes(humanP), humanP);
    expect("machine file exists",                existsSync(machineP));
    expect("human file exists",                  existsSync(humanP));
    const machineJson = JSON.parse(readFileSync(machineP, "utf-8"));
    expect("machine file has adapter_id=cloudflare-dns", machineJson.adapter_id === "cloudflare-dns");
    expect("machine file preserves api_token (Phase A plaintext)", machineJson.config?.api_token === fakeCfg.api_token);
    const md = readFileSync(humanP, "utf-8");
    expect("human file is markdown with domain", md.includes("smoke-test.example"));
    expect("human file does NOT leak api_token", !md.includes(fakeCfg.api_token));
    expect("notes array non-empty", Array.isArray(result.notes) && result.notes.length > 0);
  } finally {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  // 5. DB upsert round-trip — synthesize a user row for FK satisfaction; clean up after.
  console.log("\n5. DB layer round-trip (upsert / read / delete)");
  const db = getDb();
  const SMOKE_USER = newId();
  const now = nowIso();
  let userInserted = false;
  try {
    db.query(
      `INSERT INTO users (id, display_name, email, created_at) VALUES (?, ?, ?, ?)`,
    ).run(SMOKE_USER, "smoke-distribution", null, now);
    userInserted = true;
  } catch (e) {
    console.log(`  (could not seed smoke user: ${String(e).slice(0, 120)})`);
  }
  try {
    const link = upsertDistributionLink(SMOKE_USER, "cloudflare-dns", {
      config: { api_token: "x".repeat(40), zone_id: "abcd1234", domain: "smoke.example" },
      project: "SmokeProject",
      status: "configured",
    });
    expect("upsertDistributionLink wrote row", link.adapter_id === "cloudflare-dns");
    const got = getDistributionLink(SMOKE_USER, "cloudflare-dns");
    expect("getDistributionLink retrieves it", got !== null);
    expect("config persisted as object",
      got !== null && got.config !== null && typeof (got.config as Record<string, unknown>)?.api_token === "string");
    expect("status default is 'configured'", got?.status === "configured");
    deleteDistributionLink(SMOKE_USER, "cloudflare-dns");
    const after = getDistributionLink(SMOKE_USER, "cloudflare-dns");
    expect("deleteDistributionLink removed it", after === null);
  } catch (e) {
    expect("DB layer round-trip", false, String(e).slice(0, 200));
  } finally {
    if (userInserted) {
      try { db.query(`DELETE FROM users WHERE id = ?`).run(SMOKE_USER); } catch { /* ignore */ }
    }
  }

  // 6. verify() — bogus token, real API. Best-effort: assert it returns a result
  //    with detail and didn't crash. If the network is down, mark "info" pass.
  console.log("\n6. verify() — Cloudflare API probe (bogus token)");
  try {
    const v = await cf.verify({
      config: { api_token: "FAKE_" + "x".repeat(40), zone_id: "abcd1234", domain: "smoke.example" },
    });
    expect("verify() returns a result with detail", typeof v.ok === "boolean" && typeof v.detail === "string" && v.detail.length > 0,
      JSON.stringify(v).slice(0, 200));
    // Bogus token SHOULD fail auth — assert ok=false. Network failure also fine.
    expect("verify() returns ok=false for bogus token (or unreachable)", v.ok === false, `ok=${v.ok} detail=${v.detail}`);
  } catch (e) {
    expect("verify() didn't throw", false, String(e));
  }

  console.log(`\n=== ${pass} passed · ${fail} failed ===`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("smoke crashed:", e);
  process.exit(1);
});
