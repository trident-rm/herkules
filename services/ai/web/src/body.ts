/**
 * Stored bodies as something to look at. A body is JSON, a server-sent event stream, or
 * neither (a cut-off body, an HTML error page). Pure, so it is tested.
 */

export type Parsed =
  | { kind: "json"; value: unknown }
  | { kind: "events"; events: unknown[] }
  | { kind: "text" };

/** JSON first; Siphon pads non-streamed replies with leading spaces, which JSON allows. */
export function parseBody(text: string): Parsed {
  const trimmed = text.trim();
  if (!trimmed) return { kind: "text" };
  try {
    return { kind: "json", value: JSON.parse(trimmed) };
  } catch {
    // Not one JSON document; try an event stream.
  }
  const events = parseEvents(trimmed);
  return events.length > 0 ? { kind: "events", events } : { kind: "text" };
}

/**
 * The `data:` payloads of an event stream, parsed as JSON where they are. Comments,
 * keep-alive pings and `[DONE]` are dropped; `event:` names are kept on the payload as
 * `event` when the payload has no `type` of its own.
 */
export function parseEvents(text: string): unknown[] {
  const events: unknown[] = [];
  for (const block of text.split(/\r?\n\r?\n/)) {
    let name: string | undefined;
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) name = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (data.length === 0) continue;
    const payload = data.join("\n");
    if (payload === "[DONE]") continue;
    try {
      const value: unknown = JSON.parse(payload);
      if (name && isObject(value) && !("type" in value)) events.push({ event: name, ...value });
      else events.push(value);
    } catch {
      events.push(payload);
    }
  }
  return events;
}

export interface Assembled {
  reasoning: string;
  text: string;
}

/**
 * The assistant's text and reasoning from a response, for the OpenAI chat, Anthropic
 * messages and Responses shapes, streamed or not. Empty strings when there is none.
 */
export function assemble(parsed: Parsed): Assembled {
  const out: Assembled = { reasoning: "", text: "" };
  const items =
    parsed.kind === "events" ? parsed.events : parsed.kind === "json" ? [parsed.value] : [];
  for (const item of items) {
    if (!isObject(item)) continue;
    // OpenAI chat: choices[].delta (stream) or choices[].message.
    for (const choice of array(item.choices)) {
      if (!isObject(choice)) continue;
      const part = isObject(choice.delta)
        ? choice.delta
        : isObject(choice.message)
          ? choice.message
          : {};
      out.text += string(part.content);
      out.reasoning += string(part.reasoning_content) + string(part.reasoning);
    }
    // Anthropic stream deltas.
    if (item.type === "content_block_delta" && isObject(item.delta)) {
      out.text += string(item.delta.text);
      out.reasoning += string(item.delta.thinking);
    }
    // Anthropic message (plain) and the Responses API's output items.
    const blocks = item.type === "message" ? array(item.content) : [];
    for (const output of array(item.output))
      if (isObject(output)) blocks.push(...array(output.content));
    for (const block of blocks) {
      if (!isObject(block)) continue;
      if (block.type === "text" || block.type === "output_text") out.text += string(block.text);
      if (block.type === "thinking") out.reasoning += string(block.thinking);
    }
    // Responses API stream.
    if (item.type === "response.output_text.delta") out.text += string(item.delta);
    if (item.type === "response.reasoning_text.delta") out.reasoning += string(item.delta);
  }
  return out;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function array(v: unknown): unknown[] {
  return Array.isArray(v) ? [...v] : [];
}
function string(v: unknown): string {
  return typeof v === "string" ? v : "";
}
