// Chat Completions wire format.

import type { JsonValue } from "@miyoria/types";
import { z } from "zod";
import type { ChatMessage, ChatRequest, Usage } from "../types.js";

/**
 * Request body. Only `content` / `tool_calls` are ever sent for assistant messages, so
 * reasoning output (e.g. DeepSeek `reasoning_content`) never goes back. The session id is
 * never part of the body.
 */
export function requestBody(req: ChatRequest): Record<string, JsonValue> {
  const body: Record<string, JsonValue> = {
    model: req.model ?? "",
    messages: req.messages.map(wireMessage),
    stream: true,
    stream_options: { include_usage: true },
  };
  const tools = req.tools ?? [];
  if (tools.length > 0) {
    body.tools = tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }));
  }
  if (req.temperature != null) body.temperature = req.temperature;
  if (req.max_tokens != null) body.max_tokens = req.max_tokens;
  if (req.stop && req.stop.length > 0) body.stop = req.stop;
  if (req.json_mode) body.response_format = { type: "json_object" };
  return body;
}

function wireMessage(m: ChatMessage): Record<string, JsonValue> {
  const toolCalls =
    m.role === "assistant"
      ? m.tool_calls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: c.arguments },
        }))
      : [];
  // `null` for assistant messages that only carry tool calls.
  const out: Record<string, JsonValue> = {
    role: m.role,
    content: m.content !== "" || toolCalls.length === 0 ? m.content : null,
  };
  if (m.name !== null) out.name = m.name;
  if (toolCalls.length > 0) out.tool_calls = toolCalls;
  if (m.role === "tool" && m.tool_call_id !== null) out.tool_call_id = m.tool_call_id;
  return out;
}

const opt = <T extends z.ZodType>(schema: T) => schema.nullable().optional();

const WireUsageSchema = z.object({
  prompt_tokens: opt(z.number()),
  completion_tokens: opt(z.number()),
  /** DeepSeek. */
  prompt_cache_hit_tokens: opt(z.number()),
  /** OpenAI. */
  prompt_tokens_details: opt(z.object({ cached_tokens: opt(z.number()) })),
});

/** One streamed chunk; unknown fields are ignored. */
export const ChunkSchema = z.object({
  choices: opt(
    z.array(
      z.object({
        delta: opt(
          z.object({
            content: opt(z.string()),
            /** DeepSeek. */
            reasoning_content: opt(z.string()),
            /** OpenRouter and some local servers. */
            reasoning: opt(z.string()),
            tool_calls: opt(
              z.array(
                z.object({
                  index: opt(z.number()),
                  id: opt(z.string()),
                  function: opt(z.object({ name: opt(z.string()), arguments: opt(z.string()) })),
                }),
              ),
            ),
          }),
        ),
        finish_reason: opt(z.string()),
      }),
    ),
  ),
  usage: opt(WireUsageSchema),
  error: z.unknown().optional(),
});
export type Chunk = z.output<typeof ChunkSchema>;

export function wireUsage(u: z.output<typeof WireUsageSchema>): Usage {
  return {
    prompt_tokens: u.prompt_tokens ?? 0,
    completion_tokens: u.completion_tokens ?? 0,
    cached_prompt_tokens:
      u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? null,
  };
}
