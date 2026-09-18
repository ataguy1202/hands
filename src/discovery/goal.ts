/**
 * A goal spec is what someone who knows the application hands to discovery:
 * the goal in plain language, the contract they want (inputs, outputs), the
 * secrets the runtime may fill in, and the app's known business outcomes and
 * runtime conditions. The model works out the steps; the spec supplies the
 * knowledge a single happy-path run cannot observe.
 */
import fs from "node:fs";
import { z } from "zod";
import { Condition, Escalation, InputSpec, OutputSpec, Outcome, Recovery } from "../schema/capability.js";

export const GoalSpec = z.object({
  name: z.string().regex(/^[a-z][a-z0-9_]*$/),
  description: z.string(),
  goal: z.string(),
  entry: z.string().url(),
  app: z.object({ id: z.string(), surface: z.enum(["web", "legacy-web", "desktop"]).default("web") }),
  policy: z.string(),                                     // path to the policy file
  inputs: z.record(z.string(), InputSpec).default({}),
  outputs: z.record(z.string(), OutputSpec).default({}),
  secrets: z.record(z.string(), z.string()).default({}),  // env var name -> what it is for
  outcomes: z.record(z.string(), Outcome).default({}),
  recoveries: z.array(Recovery).default([]),
  escalations: z.array(Escalation).default([]),
  success: Condition.optional(),                          // if omitted, the model's checkpoint is used
  discoveryInputs: z.record(z.string(), z.string()),      // the values to use for the recorded run
  limits: z.object({ maxSteps: z.number().int().default(30), timeoutMs: z.number().int().default(8 * 60_000) }).default({ maxSteps: 30, timeoutMs: 8 * 60_000 }),
});
export type GoalSpec = z.infer<typeof GoalSpec>;

export function loadGoal(path: string): GoalSpec {
  return GoalSpec.parse(JSON.parse(fs.readFileSync(path, "utf8")));
}
