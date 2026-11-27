import { describe, expect, it } from "vite-plus/test";

import { snippets } from "../web/src/setup.ts";

describe("snippets", () => {
  const all = snippets("https://ai-api.example", "inkling-2-mini", "sk-hk-test");
  const byId = (id: string) => all.find((s) => s.id === id)!.text;

  it("points OpenAI clients, Codex and Pi at /v1 and Anthropic clients at the origin", () => {
    expect(byId("openai")).toContain("OPENAI_BASE_URL=https://ai-api.example/v1\n");
    expect(byId("codex")).toContain('base_url = "https://ai-api.example/v1"');
    expect(byId("codex")).toContain('wire_api = "responses"');
    expect(byId("anthropic")).toContain("ANTHROPIC_BASE_URL=https://ai-api.example\n");
    expect(JSON.parse(byId("pi")).providers.herkules.baseUrl).toBe("https://ai-api.example/v1");
  });

  it("carries the key and the model into every snippet", () => {
    for (const snippet of all) {
      expect(snippet.text).toContain("sk-hk-test");
      expect(snippet.text).toContain("inkling-2-mini");
    }
  });
});
