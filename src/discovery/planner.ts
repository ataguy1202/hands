/**
 * The model side of discovery. One observation in, one action out, every turn.
 *
 * The model never touches the surface. It picks from a closed vocabulary of
 * tools; the loop validates the pick against policy and dispatches it. That
 * keeps the guardrails in code, and it makes every decision recordable.
 */
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Observation } from "../surface/types.js";
import type { Redactor } from "../policy/redact.js";
import type { GoalSpec } from "./goal.js";

export const DEFAULT_MODEL = "claude-opus-5";

const Ref = z.string().regex(/^e\d+$/);
const Note = z.string().min(1).max(300);

export const Decision = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("click"), ref: Ref, note: Note }),
  z.object({ tool: z.literal("type"), ref: Ref, param: z.string().optional(), literal: z.string().optional(), secret: z.string().optional(), note: Note }),
  z.object({ tool: z.literal("select"), ref: Ref, option: z.string().optional(), param: z.string().optional(), note: Note }),
  z.object({ tool: z.literal("press"), key: z.string(), ref: Ref.optional(), note: Note }),
  z.object({ tool: z.literal("navigate"), url: z.string(), note: Note }),
  z.object({ tool: z.literal("dialog"), respond: z.enum(["accept", "dismiss"]), note: Note }),
  z.object({ tool: z.literal("extract"), ref: Ref, output: z.string(), parse: z.enum(["text", "money", "number"]), note: Note }),
  z.object({ tool: z.literal("wait"), note: Note }),
  z.object({
    tool: z.literal("done"),
    checkpointText: z.string().min(2),
    outcomes: z.array(z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]*$/), description: z.string(), textPattern: z.string() })).optional(),
    note: Note,
  }),
  z.object({ tool: z.literal("escalate"), reason: z.string().min(3) }),
]);
export type Decision = z.infer<typeof Decision>;

const tools: Anthropic.Tool[] = [
  tool("click", "Click a control (link, button, checkbox, radio, cell) by its ref.", {
    ref: { type: "string", description: "The ref shown in brackets in the tree, e.g. e12" },
    note: { type: "string", description: "Why, in one short sentence" },
  }, ["ref", "note"]),
  tool("type", "Type into a textbox by ref. Provide exactly one of param, literal, or secret. Use param whenever the text is one of the goal's inputs, and secret for credentials.", {
    ref: { type: "string" },
    param: { type: "string", description: "Name of a goal input whose value should be typed" },
    literal: { type: "string", description: "Fixed text that is part of the flow itself, never an input value or a credential" },
    secret: { type: "string", description: "Name of a secret the runtime will fill in. You never see its value." },
    note: { type: "string" },
  }, ["ref", "note"]),
  tool("select", "Choose an option in a combobox by ref. Provide option (the visible label) or param.", {
    ref: { type: "string" }, option: { type: "string" }, param: { type: "string" }, note: { type: "string" },
  }, ["ref", "note"]),
  tool("press", "Press a key, optionally with a control focused (ref).", { key: { type: "string" }, ref: { type: "string" }, note: { type: "string" } }, ["key", "note"]),
  tool("navigate", "Go directly to a URL. Only when no visible control leads there.", { url: { type: "string" }, note: { type: "string" } }, ["url", "note"]),
  tool("dialog", "Answer the native dialog that is currently blocking the page.", { respond: { type: "string", enum: ["accept", "dismiss"] }, note: { type: "string" } }, ["respond", "note"]),
  tool("extract", "Read a value off the screen into a named output. Point at the exact cell or text that holds the value.", {
    ref: { type: "string" }, output: { type: "string", description: "One of the goal's output names" },
    parse: { type: "string", enum: ["text", "money", "number"] }, note: { type: "string" },
  }, ["ref", "output", "parse", "note"]),
  tool("wait", "The page looks like it is still loading. Wait and look again.", { note: { type: "string" } }, ["note"]),
  tool("done", "The goal state is on screen and every output has been extracted. Give a short text that is visible right now and proves the goal state; it becomes the success checkpoint.", {
    checkpointText: { type: "string", description: "Visible text that proves the goal was reached, e.g. a heading or a confirmation line. Must not contain input values." },
    outcomes: {
      type: "array",
      description: "Optional. Business outcomes this flow could legitimately end in for other inputs (for example a not-found result), with the text the app would show. Only include ones you have good reason to believe exist.",
      items: { type: "object", properties: { code: { type: "string" }, description: { type: "string" }, textPattern: { type: "string" } }, required: ["code", "description", "textPattern"], additionalProperties: false },
    },
    note: { type: "string" },
  }, ["checkpointText", "note"]),
  tool("escalate", "Stop and hand the session to a human operator. Use for permission denials, unexpected states you cannot safely resolve, or anything that looks like it needs judgement about money or identity.", { reason: { type: "string" } }, ["reason"]),
];

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): Anthropic.Tool {
  return { name, description, input_schema: { type: "object", properties, required, additionalProperties: false } };
}

function systemPrompt(): string {
  return `You are the discovery driver of a computer-use automation system used in a bank's back office. You operate a legacy application through its user interface, as a careful human operator would, to accomplish one goal. Your run is recorded and compiled into a deterministic capability that will be replayed many times without you, so act deliberately: shortest correct path, one action per turn, read the screen before acting.

You see the screen as a tree of controls and text. Each node has a ref in brackets like [e12]; frames are shown with their names. A screenshot accompanies the tree when available.

Every turn you must call exactly one tool.

Rules
- Only use refs that appear in the current tree. Never invent one.
- Inputs are parameters: whenever you type a goal input's value, use the type tool with "param", not "literal". Same for select.
- Credentials are secrets: fill sign-on fields with "secret" and the secret's name. You will never see the values.
- Interstitials, notices, and confirmations that are not the goal itself: acknowledge or dismiss them and carry on. They are recorded as recoveries, not steps.
- A native dialog (confirm/alert) blocks the page. Answer it with the dialog tool. Accept only when the goal requires the action it confirms.
- Read outputs with extract, pointing at the exact cell that holds the value. Then call done with a visible checkpoint text.
- If you see a permission denial, an application error you cannot get past, a request for information you do not have, or any state where continuing could change data in a way the goal did not ask for, call escalate.
- Stay inside the goal. No unrelated navigation, no changes to other records, no retries of an irreversible action.`;
}

function goalPrompt(spec: GoalSpec): string {
  const inputs = Object.entries(spec.inputs).map(([k, v]) => `- ${k}: ${v.description}${v.sensitive ? " (sensitive)" : ""} = ${JSON.stringify(spec.discoveryInputs[k] ?? "")}`).join("\n") || "- none";
  const outputs = Object.entries(spec.outputs).map(([k, v]) => `- ${k} (${v.type}): ${v.description}`).join("\n") || "- none";
  const secrets = Object.entries(spec.secrets).map(([k, v]) => `- ${k}: ${v}`).join("\n") || "- none";
  return `Goal: ${spec.goal}

Application: ${spec.app.id} (${spec.app.surface}), entry point ${spec.entry}

Inputs for this run (type them with param):
${inputs}

Outputs to extract before calling done:
${outputs}

Secrets available to the runtime (type them with secret):
${secrets}`;
}

export type PlannerTurn = {
  decision: Decision;
  toolUseId: string;
  reasoning?: string;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

export class Planner {
  private readonly client = new Anthropic();
  private readonly messages: Anthropic.MessageParam[] = [];
  private pendingToolUse?: string;
  readonly model: string;
  readonly transcript: unknown[] = [];

  constructor(private readonly spec: GoalSpec, private readonly redactor: Redactor, opts: { model?: string; vision?: boolean } = {}) {
    this.model = opts.model ?? process.env.HANDS_MODEL ?? DEFAULT_MODEL;
    this.vision = opts.vision ?? true;
  }
  private readonly vision: boolean;

  /**
   * Feed the result of the previous action (if any) plus the new observation,
   * and get the next decision. Retries once if the model replies without a tool call.
   */
  async next(observation: Observation, lastResult?: { text: string; isError?: boolean }): Promise<PlannerTurn> {
    const screen = this.observationBlocks(observation);
    if (this.pendingToolUse) {
      const content: Anthropic.ToolResultBlockParam["content"] = [{ type: "text", text: lastResult?.text ?? "ok" }, ...screen];
      this.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: this.pendingToolUse, content, is_error: lastResult?.isError ?? false }] });
    } else {
      this.messages.push({ role: "user", content: [{ type: "text", text: goalPrompt(this.spec) }, ...screen] });
    }
    this.trimImages();

    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: 4000,
        system: [{ type: "text", text: systemPrompt(), cache_control: { type: "ephemeral" } }],
        tools,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        thinking: { type: "adaptive", display: "summarized" },
        cache_control: { type: "ephemeral" },
        messages: this.messages,
      });
      this.messages.push({ role: "assistant", content: response.content });
      this.transcript.push(this.redactor.value({ at: new Date().toISOString(), stop: response.stop_reason, content: response.content, usage: response.usage }));

      const use = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
      const reasoning = response.content.filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking").map((b) => b.thinking).join("\n").trim()
        || response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim();
      const usage = {
        input: response.usage.input_tokens, output: response.usage.output_tokens,
        cacheRead: response.usage.cache_read_input_tokens ?? 0, cacheWrite: response.usage.cache_creation_input_tokens ?? 0,
      };
      if (use) {
        const parsed = Decision.safeParse({ tool: use.name, ...(use.input as object) });
        if (parsed.success) {
          this.pendingToolUse = use.id;
          return { decision: parsed.data, toolUseId: use.id, reasoning: reasoning || undefined, usage };
        }
        this.messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: use.id, is_error: true, content: `Invalid arguments: ${parsed.error.issues.map((i) => i.message).join("; ")}. Call one tool with valid arguments.` }] });
        continue;
      }
      if (response.stop_reason === "refusal") throw new Error("the model refused to continue");
      this.messages.push({ role: "user", content: "You must call exactly one tool this turn." });
    }
    throw new Error("the model did not produce a valid tool call in two attempts");
  }

  private observationBlocks(o: Observation): (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] {
    const blocks: (Anthropic.TextBlockParam | Anthropic.ImageBlockParam)[] = [
      { type: "text", text: `Current screen (${this.redactor.text(o.url)}):\n${this.redactor.text(o.tree)}` },
    ];
    if (this.vision && o.screenshot?.length) {
      blocks.push({ type: "image", source: { type: "base64", media_type: "image/png", data: o.screenshot.toString("base64") } });
    }
    return blocks;
  }

  /** Keep screenshots only for the two most recent turns; older ones cost tokens and add nothing. */
  private trimImages() {
    let kept = 0;
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i]!;
      if (m.role !== "user" || typeof m.content === "string") continue;
      for (const block of m.content) {
        const inner = block.type === "tool_result" && Array.isArray(block.content) ? block.content : block.type === "image" ? [block] : [];
        for (let j = 0; j < inner.length; j++) {
          if (inner[j]!.type !== "image") continue;
          if (kept < 2) { kept++; continue; }
          inner[j] = { type: "text", text: "[earlier screenshot omitted]" } as Anthropic.TextBlockParam;
        }
        if (block.type === "image" && inner[0]?.type === "text") (m.content as unknown[])[m.content.indexOf(block)] = inner[0];
      }
    }
  }
}
