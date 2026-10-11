/**
 * Runs every adversarial scenario against the real runtime and writes
 * agent/SIMULATION.md. Exit code 1 if any claim fails.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoRoot, type Check } from "./harness.js";
import { scenarios } from "./scenarios.js";

interface Result { name: string; description: string; checks: Check[]; notes: string[]; events: number; ms: number }

const results: Result[] = [];
let failed = 0;
for (const sc of scenarios) {
  const started = Date.now();
  try {
    const sim = await sc.run();
    const bad = sim.checks.filter((c) => !c.ok).length;
    failed += bad;
    results.push({ name: sc.name, description: sc.description, checks: sim.checks, notes: sim.notes, events: sim.events.length, ms: Date.now() - started });
    console.log(`${bad ? "FAIL" : "ok  "} ${sc.name}  (${sim.checks.length} checks, ${sim.events.length} ledger events, ${Date.now() - started} ms)`);
    for (const c of sim.checks) if (!c.ok) console.log(`       x ${c.claim}${c.detail ? ": " + c.detail : ""}`);
    for (const n of sim.notes) console.log(`       note: ${n}`);
  } catch (e) {
    failed++;
    results.push({ name: sc.name, description: sc.description, checks: [{ claim: "scenario ran without throwing", ok: false, detail: (e as Error).stack ?? String(e) }], notes: [], events: 0, ms: Date.now() - started });
    console.log(`FAIL ${sc.name}: ${(e as Error).message}`);
  }
}

const total = results.reduce((a, r) => a + r.checks.length, 0);
const lines: string[] = [];
lines.push("# Simulation report", "", `Generated ${new Date().toISOString().slice(0, 10)} by \`npm run sim\`. ${results.length} scenarios, ${total} claims, ${failed} failed. Each scenario runs the real agent runtime against in-memory GitHub and chain adapters on a fake clock, and ends by replaying its own signed ledger.`, "");
for (const r of results) {
  lines.push(`## ${r.name}`, "", r.description, "", `${r.events} ledger events, ${r.ms} ms.`, "");
  for (const c of r.checks) lines.push(`- ${c.ok ? "pass" : "FAIL"}: ${c.claim}${c.detail && !c.ok ? ` (${c.detail})` : ""}`);
  for (const n of r.notes) lines.push(`- note: ${n}`);
  lines.push("");
}
writeFileSync(resolve(repoRoot, "agent", "SIMULATION.md"), lines.join("\n"), "utf8");
console.log(`\n${results.length} scenarios, ${total} claims, ${failed} failed. Report: agent/SIMULATION.md`);
process.exitCode = failed ? 1 : 0;
