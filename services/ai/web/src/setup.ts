/** Copy-paste client setup for a key, by client. Pure, so the snippets are tested. */

export interface Snippet {
  id: string;
  title: string;
  /** Where the text goes. */
  file: string;
  text: string;
}

export function snippets(apiOrigin: string, model: string, key: string): Snippet[] {
  const v1 = `${apiOrigin}/v1`;
  return [
    {
      id: "openai",
      title: "OpenAI API",
      file: "shell",
      text: [
        `export OPENAI_BASE_URL=${v1}`,
        `export OPENAI_API_KEY=${key}`,
        `# model: ${model}. OpenAI's SDKs stop a request after 10 minutes; raise their timeout for longer runs.`,
      ].join("\n"),
    },
    {
      id: "anthropic",
      title: "Anthropic API and Claude Code",
      file: "shell",
      text: [
        `export ANTHROPIC_BASE_URL=${apiOrigin}`,
        `export ANTHROPIC_AUTH_TOKEN=${key}`,
        `export ANTHROPIC_MODEL=${model}`,
        `export ANTHROPIC_DEFAULT_HAIKU_MODEL=${model}`,
        "# Long prefills can take minutes; Claude Code's default is 10 minutes per request.",
        "export API_TIMEOUT_MS=1800000",
      ].join("\n"),
    },
    {
      id: "codex",
      title: "Codex",
      file: "~/.codex/herkules.config.toml, then codex -p herkules",
      text: [
        `model = "${model}"`,
        `model_provider = "herkules"`,
        `model_reasoning_effort = "medium"`,
        "",
        "[model_providers.herkules]",
        `name = "Herkules"`,
        `base_url = "${v1}"`,
        `wire_api = "responses"`,
        `env_key = "HERKULES_API_KEY"`,
        "",
        `# export HERKULES_API_KEY=${key}`,
      ].join("\n"),
    },
    {
      id: "pi",
      title: "Pi",
      file: "~/.pi/agent/models.json",
      text: JSON.stringify(
        {
          providers: {
            herkules: {
              baseUrl: v1,
              api: "openai-completions",
              apiKey: key,
              models: [{ id: model, name: model, reasoning: true, input: ["text", "image"] }],
            },
          },
        },
        null,
        2,
      ),
    },
  ];
}
