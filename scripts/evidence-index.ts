/**
 * Writes evidence/README.md from the runs on disk. Every row comes from a
 * result.json or a run's final event, so the index cannot drift from the evidence.
 */
import fs from "node:fs";
import path from "node:path";

const root = "evidence";
const runs = fs.readdirSync(root).filter((d) => fs.existsSync(path.join(root, d, "events.jsonl"))).sort();
const rows: string[] = [];

for (const id of runs) {
  const dir = path.join(root, id);
  const events = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = events.at(-1) ?? {};
  const started = events.find((e) => e.type === "run.started") ?? {};
  const shots = fs.existsSync(path.join(dir, "steps")) ? fs.readdirSync(path.join(dir, "steps")).length : 0;
  let what = "";
  let result = "";
  if (id.startsWith("discovery-")) {
    what = `discovery · ${started.model ?? ""} · ${last.modelSteps ?? "?"} model turns`;
    const u = last.usage ?? {};
    result = `${last.status}: ${last.steps} steps, ${last.recoveries} recoveries, ${last.outcomes} outcomes · tokens in ${(u.input ?? 0) + (u.cacheRead ?? 0) + (u.cacheWrite ?? 0)} (cached ${u.cacheRead ?? 0}) out ${u.output ?? 0}`;
  } else {
    const r = JSON.parse(fs.readFileSync(path.join(dir, "result.json"), "utf8"));
    const label = id.replace(/^replay-/, "").replace(/-\d{8}T\d{6}Z$/, "").replace(`${r.capability.name}-`, "");
    what = `replay · ${r.capability.name} · ${label === r.capability.name ? "" : label} · inputs ${JSON.stringify(started.inputs ?? {})}`;
    const bits = [r.status];
    if (r.outputs) bits.push(`outputs ${JSON.stringify(r.outputs)}`);
    if (r.outcome) bits.push(`outcome ${r.outcome.code}`);
    if (r.failure) bits.push(`failure ${r.failure.class}${r.failure.atStep ? ` at ${r.failure.atStep}` : ""}: ${r.failure.message}`);
    if (r.recoveries?.length) bits.push(`recoveries ${r.recoveries.map((x: any) => `${x.id}@${x.atStep}`).join(", ")}`);
    if (r.escalations?.length) bits.push(`escalations ${r.escalations.map((x: any) => `${x.kind}/${x.resolution}${x.humanActions ? ` (${x.humanActions} human actions)` : ""}`).join(", ")}`);
    if (r.drift?.length) bits.push(`drift ${r.drift.length}`);
    bits.push(`${r.stepsCompleted} steps, ${(r.durationMs / 1000).toFixed(1)}s`);
    result = bits.join(" · ");
  }
  rows.push(`| [${id}](${id}/) | ${what.replace(/\|/g, "\\|")} | ${result.replace(/\|/g, "\\|")} | ${shots} |`);
}

const md = `# Evidence

Every run below is a real execution against the mock core, recorded by the system itself. Each folder holds \`events.jsonl\` (the structured log), \`steps/\` (screenshots), \`snapshots/\` (the perceived tree at each observation), \`report.html\` (the same log rendered), and for discovery runs \`transcript.json\` (the model's turns, redacted) and \`capability.json\` (what was compiled). Replay runs also carry \`result.json\` and, when a person was involved, \`interventions/\`.

\`report.html\` is meant to be opened from a clone; on GitHub, read \`events.jsonl\` and browse \`steps/\` directly. Regenerate this index with \`npx tsx scripts/evidence-index.ts\`.

| run | what | result | shots |
|---|---|---|---|
${rows.join("\n")}
`;
fs.writeFileSync(path.join(root, "README.md"), md);
console.log(`${runs.length} runs indexed`);
