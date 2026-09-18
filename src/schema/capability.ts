/**
 * The capability artifact: what a successful discovery run compiles into, and
 * what the replay engine executes. Designed to be read by a reviewer and
 * called by an agent, so the contract (inputs, outputs, outcomes) sits at the
 * top and the mechanics (steps, targets, recoveries) below it.
 *
 * Nothing in here references the model transcript. Provenance points at the
 * evidence folder instead.
 */
import { z } from "zod";

// ---------- Targeting ----------
//
// A target is not a selector. It is a description of a control with several
// ways to find it, ordered from most semantic (survives restyling, reordering,
// re-versioning) to most structural (survives nothing). Replay walks the list
// and reports which strategy matched so drift is visible before it breaks.

export const TargetStrategy = z.discriminatedUnion("kind", [
  // Accessible role + name, computed by our own walker (works without <label>).
  z.object({ kind: z.literal("role"), role: z.string(), name: z.string().optional() }),
  // The text of the label cell or element immediately left of / above a field. Table-layout apps live on this.
  z.object({ kind: z.literal("anchor"), text: z.string(), tag: z.string() }),
  // Form field name/type attributes. Legacy apps rarely rename these; they are wired to the backend.
  z.object({ kind: z.literal("attr"), tag: z.string(), attrs: z.record(z.string(), z.string()) }),
  // Exact visible text of a link, button, heading or cell.
  z.object({ kind: z.literal("text"), text: z.string(), tag: z.string().optional() }),
  // A table cell addressed by column header and a value in the same row. For extraction from grids.
  z.object({ kind: z.literal("cell"), column: z.string(), rowContains: z.string() }),
  // Structural path. Last resort; recorded so a human can still see where it was.
  z.object({ kind: z.literal("css"), selector: z.string() }),
]);
export type TargetStrategy = z.infer<typeof TargetStrategy>;

export const Target = z.object({
  describe: z.string(),                       // e.g. textbox "Member Number"
  frame: z.array(z.string()),                 // frame name path from the top document; [] is the top
  strategies: z.array(TargetStrategy).min(1),
  // Identity check applied to every strategy's match. Name is included for controls whose
  // caption is part of what they are (a button, a field's label), never for value cells.
  fingerprint: z.object({ tag: z.string(), type: z.string().optional(), role: z.string(), name: z.string().optional() }),
});
export type Target = z.infer<typeof Target>;

// ---------- Values ----------

export const Value = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("param"), name: z.string() }),     // supplied per invocation
  z.object({ kind: z.literal("literal"), value: z.string() }),  // fixed in the flow
  z.object({ kind: z.literal("secret"), name: z.string() }),    // resolved from the runtime's secret store, never stored
]);
export type Value = z.infer<typeof Value>;

// ---------- Conditions ----------
//
// Checkpoints, outcome detectors, recovery triggers and the success condition
// are all Conditions. One evaluator, one vocabulary.

export type Condition =
  | { kind: "visible"; target: Target }
  | { kind: "text"; pattern: string; frame?: string[] }      // regex, case-insensitive, over visible text
  | { kind: "url"; pattern: string }                          // regex over the main document URL
  | { kind: "dialog"; pattern: string }                       // a native dialog whose message matches
  | { kind: "all_of"; conditions: Condition[] }
  | { kind: "any_of"; conditions: Condition[] }
  | { kind: "not"; condition: Condition };

export const Condition: z.ZodType<Condition> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("visible"), target: Target }),
    z.object({ kind: z.literal("text"), pattern: z.string(), frame: z.array(z.string()).optional() }),
    z.object({ kind: z.literal("url"), pattern: z.string() }),
    z.object({ kind: z.literal("dialog"), pattern: z.string() }),
    z.object({ kind: z.literal("all_of"), conditions: z.array(Condition) }),
    z.object({ kind: z.literal("any_of"), conditions: z.array(Condition) }),
    z.object({ kind: z.literal("not"), condition: Condition }),
  ]),
);

// ---------- Steps ----------

const StepBase = {
  id: z.string(),
  note: z.string().optional(),                 // the model's stated intent at discovery time, for reviewers
  risk: z.enum(["safe", "irreversible"]).default("safe"),
  expect: Condition.optional(),                // post-condition: proves the step took effect before moving on
  timeoutMs: z.number().int().positive().default(8000),
};

/** A native dialog the step is expected to raise, and how to answer it. */
export const DialogResponse = z.object({
  type: z.enum(["alert", "confirm", "prompt"]),
  pattern: z.string(),
  respond: z.enum(["accept", "dismiss"]),
});

export const Step = z.discriminatedUnion("action", [
  z.object({ ...StepBase, action: z.literal("navigate"), url: z.string() }), // may contain {{param}} placeholders
  z.object({ ...StepBase, action: z.literal("click"), target: Target, dialog: DialogResponse.optional() }),
  z.object({ ...StepBase, action: z.literal("type"), target: Target, value: Value }),
  z.object({ ...StepBase, action: z.literal("select"), target: Target, value: Value }),
  z.object({ ...StepBase, action: z.literal("press"), target: Target.optional(), key: z.string() }),
  z.object({ ...StepBase, action: z.literal("extract"), target: Target, output: z.string(), parse: z.enum(["text", "money", "number"]) }),
  z.object({ ...StepBase, action: z.literal("assert"), condition: Condition }),
]);
export type Step = z.infer<typeof Step>;

// ---------- Contract ----------

export const InputSpec = z.object({
  type: z.enum(["string", "number", "boolean"]),
  description: z.string(),
  required: z.boolean().default(true),
  pattern: z.string().optional(),
  example: z.string().optional(),
  sensitive: z.boolean().default(false),       // redacted in logs and evidence
});
export const OutputSpec = z.object({
  type: z.enum(["string", "number", "money", "boolean"]),
  description: z.string(),
});

/** An expected business result. A legitimate answer for the caller, not an error. */
export const Outcome = z.object({
  description: z.string(),
  detect: Condition,
});

/** A known condition the engine can clear on its own, with a bounded budget. */
export const Recovery = z.object({
  id: z.string(),
  description: z.string(),
  detect: Condition,
  action: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("click"), target: Target }),
    z.object({ kind: z.literal("retry_step"), delayMs: z.number().int().nonnegative().default(1000) }),
    z.object({ kind: z.literal("restart") }),  // re-run from step 1; refused after any irreversible step
  ]),
  maxAttempts: z.number().int().positive().default(2),
});

/** A condition the engine must not try to clear itself. Route to a person. */
export const Escalation = z.object({
  id: z.string(),
  description: z.string(),
  detect: Condition,
});

export type Recovery = z.infer<typeof Recovery>;
export type Outcome = z.infer<typeof Outcome>;
export type Escalation = z.infer<typeof Escalation>;
export type InputSpec = z.infer<typeof InputSpec>;
export type OutputSpec = z.infer<typeof OutputSpec>;

export const Capability = z.object({
  schemaVersion: z.literal("1.0"),
  id: z.string(),
  name: z.string().regex(/^[a-z][a-z0-9_]*$/, "snake_case, usable as a tool name"),
  version: z.number().int().positive(),
  status: z.enum(["draft", "verified", "approved"]),
  description: z.string(),
  app: z.object({
    id: z.string(),                            // the vendor product, e.g. meridian-coresuite
    surface: z.enum(["web", "legacy-web", "desktop"]),
    entry: z.string(),                         // where a run starts
    variant: z.string().optional(),            // a tenant/version specialisation, if any
  }),
  inputs: z.record(z.string(), InputSpec),
  outputs: z.record(z.string(), OutputSpec),
  steps: z.array(Step).min(1),
  success: Condition,
  outcomes: z.record(z.string(), Outcome),
  recoveries: z.array(Recovery),
  escalations: z.array(Escalation),
  policy: z.object({
    effect: z.enum(["read_only", "mutating"]),
    irreversibleSteps: z.array(z.string()),
  }),
  provenance: z.object({
    discoveredAt: z.string(),
    discoveryRunId: z.string(),
    model: z.string(),
    surfaceDriver: z.string(),
    evidence: z.string(),
  }),
  stats: z
    .object({ replays: z.number().int(), succeeded: z.number().int(), lastReplayAt: z.string().optional() })
    .default({ replays: 0, succeeded: 0 }),
});
export type Capability = z.infer<typeof Capability>;
export type CapabilityInput = z.input<typeof Capability>;

/** Substitute {{name}} placeholders with input values. Unknown names are left intact so they fail loudly downstream. */
export function renderTemplate(template: string, inputs: Record<string, unknown>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (m, name: string) => (name in inputs ? String(inputs[name]) : m));
}
