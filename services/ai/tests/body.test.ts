import { describe, expect, it } from "vite-plus/test";

import { assemble, parseBody } from "../web/src/body.ts";

describe("parseBody", () => {
  it("reads padded JSON", () => {
    expect(parseBody('   {"a":1}')).toEqual({ kind: "json", value: { a: 1 } });
  });

  it("reads an event stream and drops pings and [DONE]", () => {
    const text = [
      ": ping",
      "",
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      "",
      "event: message_stop",
      'data: {"x":1}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(parseBody(text)).toEqual({
      kind: "events",
      events: [{ choices: [{ delta: { content: "Hel" } }] }, { event: "message_stop", x: 1 }],
    });
  });

  it("falls back to text", () => {
    expect(parseBody("<html>502</html>").kind).toBe("text");
    expect(parseBody('{"cut off').kind).toBe("text");
  });
});

describe("assemble", () => {
  it("joins OpenAI chat deltas", () => {
    const body = [
      'data: {"choices":[{"delta":{"reasoning_content":"think"}}]}',
      'data: {"choices":[{"delta":{"content":"Hel"}}]}',
      'data: {"choices":[{"delta":{"content":"lo"}}]}',
    ].join("\n\n");
    expect(assemble(parseBody(body))).toEqual({ reasoning: "think", text: "Hello" });
  });

  it("reads Anthropic streams and messages", () => {
    const stream = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"hm"}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"Hi"}}',
    ].join("\n\n");
    expect(assemble(parseBody(stream))).toEqual({ reasoning: "hm", text: "Hi" });
    const message = { type: "message", content: [{ type: "text", text: "Yo" }] };
    expect(assemble(parseBody(JSON.stringify(message))).text).toBe("Yo");
  });

  it("reads the Responses API without double counting the final event", () => {
    const stream = [
      'data: {"type":"response.output_text.delta","delta":"A"}',
      'data: {"type":"response.completed","response":{"output":[{"type":"message","content":[{"type":"output_text","text":"A"}]}]}}',
    ].join("\n\n");
    expect(assemble(parseBody(stream)).text).toBe("A");
    const plain = { output: [{ type: "message", content: [{ type: "output_text", text: "B" }] }] };
    expect(assemble(parseBody(JSON.stringify(plain))).text).toBe("B");
  });
});
