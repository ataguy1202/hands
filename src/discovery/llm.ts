/**
 * The model client seam. The planner keeps a provider-neutral transcript and
 * asks for one completion at a time; a provider renders that transcript into
 * its wire format. Two providers: the Anthropic API directly, and OpenRouter's
 * OpenAI-compatible endpoint (for accounts that route Claude through it).
 *
 * Selection: HANDS_LLM=anthropic|openrouter, else whichever key is present.
 */
import Anthropic from "@anthropic-ai/sdk";

export type ToolSpec = { name: string; description: string; inputSchema: Record<string, unknown> };

export type UserPart =
  | { type: "text"; text: string }
  | { type: "image"; png: Buffer }
  | { type: "tool_result"; id: string; text: string; isError?: boolean };

export type Turn =
  | { role: "user"; parts: UserPart[] }
  | { role: "assistant"; text?: string; reasoning?: string; toolUse?: { id: string; name: string; input: unknown }; raw?: unknown };

export type Usage = { input: number; output: number; cacheRead: number; cacheWrite: number };
export type Completion = {
  toolUse?: { id: string; name: string; input: unknown };
  text: string;
  reasoning?: string;
  stopReason: string;
  usage: Usage;
  raw: unknown;               // provider-specific assistant content, replayed verbatim on later turns
};

export interface ModelClient {
  readonly provider: string;
  readonly model: string;
  complete(system: string, turns: Turn[], tools: ToolSpec[], opts?: { maxTokens?: number }): Promise<Completion>;
}

export const DEFAULT_MODELS = { anthropic: "claude-opus-5", openrouter: "anthropic/claude-opus-5" } as const;

export function createModelClient(opts: { model?: string } = {}): ModelClient {
  const forced = process.env.HANDS_LLM;
  const provider = forced === "anthropic" || forced === "openrouter" ? forced : process.env.ANTHROPIC_API_KEY ? "anthropic" : process.env.OPENROUTER_API_KEY ? "openrouter" : undefined;
  if (!provider) throw new Error("no model access: set ANTHROPIC_API_KEY or OPENROUTER_API_KEY (discovery only; replay needs neither)");
  const model = opts.model ?? process.env.HANDS_MODEL ?? DEFAULT_MODELS[provider];
  return provider === "anthropic" ? new AnthropicClient(model) : new OpenRouterClient(model);
}

// ---------- Anthropic ----------

class AnthropicClient implements ModelClient {
  readonly provider = "anthropic";
  private readonly client = new Anthropic();
  constructor(readonly model: string) {}

  async complete(system: string, turns: Turn[], tools: ToolSpec[], opts: { maxTokens?: number } = {}): Promise<Completion> {
    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: opts.maxTokens ?? 4000,
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema as Anthropic.Tool.InputSchema })),
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      thinking: { type: "adaptive", display: "summarized" },
      cache_control: { type: "ephemeral" },
      messages: turns.map(toAnthropic),
    });
    const use = response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
    return {
      toolUse: use ? { id: use.id, name: use.name, input: use.input } : undefined,
      text: response.content.filter((b): b is Anthropic.TextBlock => b.type === "text").map((b) => b.text).join("\n").trim(),
      reasoning: response.content.filter((b): b is Anthropic.ThinkingBlock => b.type === "thinking").map((b) => b.thinking).join("\n").trim() || undefined,
      stopReason: response.stop_reason ?? "unknown",
      usage: { input: response.usage.input_tokens, output: response.usage.output_tokens, cacheRead: response.usage.cache_read_input_tokens ?? 0, cacheWrite: response.usage.cache_creation_input_tokens ?? 0 },
      raw: response.content,
    };
  }
}

function toAnthropic(t: Turn): Anthropic.MessageParam {
  if (t.role === "assistant") {
    if (t.raw) return { role: "assistant", content: t.raw as Anthropic.ContentBlockParam[] };
    const content: Anthropic.ContentBlockParam[] = [];
    if (t.text) content.push({ type: "text", text: t.text });
    if (t.toolUse) content.push({ type: "tool_use", id: t.toolUse.id, name: t.toolUse.name, input: t.toolUse.input });
    return { role: "assistant", content };
  }
  const content: Anthropic.ContentBlockParam[] = [];
  for (const p of t.parts) {
    if (p.type === "text") content.push({ type: "text", text: p.text });
    else if (p.type === "image") content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: p.png.toString("base64") } });
  }
  const results = t.parts.filter((p): p is Extract<UserPart, { type: "tool_result" }> => p.type === "tool_result");
  if (results.length) {
    // The screen that follows a tool result travels inside the result, which is how computer-use turns are shaped.
    return { role: "user", content: results.map((r) => ({ type: "tool_result" as const, tool_use_id: r.id, is_error: r.isError ?? false, content: [{ type: "text" as const, text: r.text }, ...content] as Anthropic.ToolResultBlockParam["content"] })) };
  }
  return { role: "user", content };
}

// ---------- OpenRouter (OpenAI-compatible) ----------

type ORMessage = Record<string, unknown>;

class OpenRouterClient implements ModelClient {
  readonly provider = "openrouter";
  private readonly key = process.env.OPENROUTER_API_KEY!;
  constructor(readonly model: string) {}

  async complete(system: string, turns: Turn[], tools: ToolSpec[], opts: { maxTokens?: number } = {}): Promise<Completion> {
    const messages: ORMessage[] = [{ role: "system", content: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] }];
    for (const t of turns) messages.push(...toOpenRouter(t));
    const body = {
      model: this.model,
      max_tokens: opts.maxTokens ?? 4000,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })),
      tool_choice: "auto",
      parallel_tool_calls: false,
      reasoning: { effort: "medium" },
    };
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${this.key}`, "content-type": "application/json", "x-title": "hands" },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as any;
    if (!res.ok || json.error) throw new Error(`openrouter ${res.status}: ${json.error?.message ?? res.statusText}`);
    const choice = json.choices?.[0];
    const msg = choice?.message ?? {};
    const call = msg.tool_calls?.[0];
    let input: unknown = {};
    if (call) { try { input = JSON.parse(call.function.arguments || "{}"); } catch { input = { __invalid: call.function.arguments }; } }
    return {
      toolUse: call ? { id: call.id, name: call.function.name, input } : undefined,
      text: typeof msg.content === "string" ? msg.content.trim() : "",
      reasoning: typeof msg.reasoning === "string" && msg.reasoning.trim() ? msg.reasoning.trim() : undefined,
      stopReason: choice?.finish_reason ?? "unknown",
      usage: {
        input: json.usage?.prompt_tokens ?? 0, output: json.usage?.completion_tokens ?? 0,
        cacheRead: json.usage?.prompt_tokens_details?.cached_tokens ?? 0, cacheWrite: json.usage?.prompt_tokens_details?.cache_write_tokens ?? 0,
      },
      raw: { content: msg.content ?? null, tool_calls: msg.tool_calls, reasoning_details: msg.reasoning_details },
    };
  }
}

function toOpenRouter(t: Turn): ORMessage[] {
  if (t.role === "assistant") {
    const raw = t.raw as { content?: unknown; tool_calls?: unknown; reasoning_details?: unknown } | undefined;
    if (raw) {
      const m: ORMessage = { role: "assistant", content: raw.content ?? null };
      if (raw.tool_calls) m.tool_calls = raw.tool_calls;
      if (raw.reasoning_details) m.reasoning_details = raw.reasoning_details;   // keeps Claude's thinking continuity across tool turns
      return [m];
    }
    const m: ORMessage = { role: "assistant", content: t.text ?? null };
    if (t.toolUse) m.tool_calls = [{ id: t.toolUse.id, type: "function", function: { name: t.toolUse.name, arguments: JSON.stringify(t.toolUse.input) } }];
    return [m];
  }
  const out: ORMessage[] = [];
  const content: ORMessage[] = [];
  for (const p of t.parts) {
    if (p.type === "tool_result") out.push({ role: "tool", tool_call_id: p.id, content: (p.isError ? "ERROR: " : "") + p.text });
    else if (p.type === "text") content.push({ type: "text", text: p.text });
    else content.push({ type: "image_url", image_url: { url: `data:image/png;base64,${p.png.toString("base64")}` } });
  }
  if (content.length) out.push({ role: "user", content });
  return out;
}
