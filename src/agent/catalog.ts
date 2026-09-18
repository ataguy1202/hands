/**
 * The agent-facing side: saved capabilities as callable tools. An agent
 * discovers them by name, reads the typed contract, and invokes one with
 * arguments. Invocation is a deterministic replay; the model only ever decides
 * which capability to call and with what.
 */
import type Anthropic from "@anthropic-ai/sdk";
import type { Capability } from "../schema/capability.js";

export function toolDefinition(cap: Capability): Anthropic.Tool {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [name, spec] of Object.entries(cap.inputs)) {
    properties[name] = { type: spec.type, description: spec.description + (spec.pattern ? ` (pattern ${spec.pattern})` : ""), ...(spec.pattern ? { pattern: spec.pattern } : {}) };
    if (spec.required) required.push(name);
  }
  const outcomes = Object.entries(cap.outcomes).map(([code, o]) => `${code}: ${o.description}`).join("; ");
  const outputs = Object.entries(cap.outputs).map(([k, o]) => `${k} (${o.type}): ${o.description}`).join("; ");
  return {
    name: cap.name,
    description: `${cap.description} Returns: ${outputs || "nothing"}. Possible business outcomes: ${outcomes || "none declared"}. Effect: ${cap.policy.effect}. Status: ${cap.status} v${cap.version}.`,
    input_schema: { type: "object", properties, required, additionalProperties: false },
  };
}

export function catalogSummary(caps: Capability[]): string {
  return caps.map((c) => {
    const inputs = Object.entries(c.inputs).map(([k, v]) => `${k}: ${v.type}`).join(", ");
    const outputs = Object.entries(c.outputs).map(([k, v]) => `${k}: ${v.type}`).join(", ");
    return `${c.name} v${c.version} [${c.status}, ${c.policy.effect}]\n  ${c.description}\n  inputs  ${inputs || "none"}\n  outputs ${outputs || "none"}\n  outcomes ${Object.keys(c.outcomes).join(", ") || "none"}\n  steps ${c.steps.length}, replays ${c.stats.replays} (${c.stats.succeeded} ok)`;
  }).join("\n\n");
}
