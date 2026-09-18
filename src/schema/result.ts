/**
 * What a caller gets back from a replay. Four terminal states, kept apart on
 * purpose: "no such member" is an answer, an unexpected dialog is a failure,
 * and a human declining to continue is neither.
 */
import { z } from "zod";

export const FailureClass = z.enum([
  "invalid_input",       // caller's arguments failed the input contract; nothing was touched
  "policy_blocked",      // an action fell outside the allowlist or risk policy
  "target_not_found",    // no strategy resolved the control
  "target_ambiguous",    // a strategy matched more than one control and the fingerprint could not break the tie
  "checkpoint_failed",   // the action ran but the expected post-condition never appeared
  "unexpected_dialog",   // a dialog or interstitial no recovery knows about
  "app_error",           // the application reported an error state
  "session_lost",        // authentication was lost and could not be re-established
  "timeout",             // a wait budget ran out
  "recovery_exhausted",  // a known recovery was attempted its maximum number of times
  "escalation_failed",   // no operator console was reachable, or the intervention timed out
]);
export type FailureClass = z.infer<typeof FailureClass>;

export const Evidence = z.object({
  screenshot: z.string().optional(),   // path relative to the evidence folder
  snapshot: z.string().optional(),     // the perceived tree at the moment of failure
  url: z.string().optional(),
});

export const Failure = z.object({
  class: FailureClass,
  atStep: z.string().optional(),
  message: z.string(),
  expected: z.string().optional(),
  observed: z.string().optional(),
  evidence: Evidence.optional(),
});
export type Failure = z.infer<typeof Failure>;

export const InterventionSummary = z.object({
  id: z.string(),
  kind: z.enum(["approval", "takeover"]),
  atStep: z.string().optional(),
  reason: z.string(),
  raisedAt: z.string(),
  resolvedAt: z.string().optional(),
  resolution: z.enum(["approved", "denied", "retry_step", "skip_step", "abort", "timeout"]).optional(),
  humanActions: z.number().int().default(0),
});
export type InterventionSummary = z.infer<typeof InterventionSummary>;

export const ReplayResult = z.object({
  runId: z.string(),
  capability: z.object({ id: z.string(), name: z.string(), version: z.number().int() }),
  status: z.enum(["succeeded", "outcome", "failed", "aborted"]),
  outputs: z.record(z.string(), z.unknown()).optional(),
  outcome: z.object({ code: z.string(), description: z.string(), atStep: z.string().optional() }).optional(),
  failure: Failure.optional(),
  recoveries: z.array(z.object({ id: z.string(), atStep: z.string(), attempt: z.number().int() })),
  drift: z.array(z.object({ step: z.string(), primary: z.string(), used: z.string() })),
  escalations: z.array(InterventionSummary),
  stepsCompleted: z.number().int(),
  startedAt: z.string(),
  finishedAt: z.string(),
  durationMs: z.number().int(),
  evidenceDir: z.string(),
});
export type ReplayResult = z.infer<typeof ReplayResult>;
