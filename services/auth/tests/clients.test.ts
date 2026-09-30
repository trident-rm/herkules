import { describe, expect, test } from "vite-plus/test";
import { applyQuirks, registerBeforeHook, REDIRECT_ALLOW } from "../src/clients.ts";

describe("registration quirks", () => {
  test("application_type defaults to native; an explicit value is kept", () => {
    expect(applyQuirks({ redirect_uris: ["http://localhost:1234/cb"] })).toEqual({
      redirect_uris: ["http://localhost:1234/cb"],
      application_type: "native",
    });
    expect(
      applyQuirks({
        redirect_uris: ["https://claude.ai/api/mcp/auth_callback"],
        application_type: "web",
      }),
    ).toMatchObject({
      application_type: "web",
    });
  });

  test("Cursor's retired callback is dropped when a current callback is present", () => {
    expect(
      applyQuirks({
        client_name: "Cursor",
        redirect_uris: [
          "cursor://anysphere.cursor-mcp/oauth/callback",
          "https://www.cursor.com/agents/mcp/oauth/callback",
          "http://localhost:8787/callback",
        ],
      }),
    ).toEqual({
      client_name: "Cursor",
      redirect_uris: [
        "https://www.cursor.com/agents/mcp/oauth/callback",
        "http://localhost:8787/callback",
      ],
      application_type: "native",
    });

    expect(
      applyQuirks({
        client_name: "Old Cursor",
        redirect_uris: ["cursor://anysphere.cursor-mcp/oauth/callback"],
      }),
    ).toMatchObject({ error: "invalid_redirect_uri" });
  });

  test("every redirect_uri must match the allowlist", () => {
    expect(
      applyQuirks({ redirect_uris: ["http://127.0.0.1:9/cb", "https://evil.example/cb"] }),
    ).toEqual({
      error: "invalid_redirect_uri",
      error_description: "redirect_uri not permitted: https://evil.example/cb",
    });
    const supportedClientRedirects = {
      cursorDesktop: "http://localhost:8787/callback",
      cursorWeb: "https://www.cursor.com/agents/mcp/oauth/callback",
      geminiCli: "http://localhost:49152/oauth/callback",
      vscodeWeb: "https://vscode.dev/redirect?x=1",
      vscodePrivateScheme: "vscode://ms.ext/cb",
      zed: "http://[::1]:54321/callback",
    };
    for (const [client, redirect] of Object.entries(supportedClientRedirects)) {
      expect(
        REDIRECT_ALLOW.some((re) => re.test(redirect)),
        client,
      ).toBe(true);
    }
    expect(REDIRECT_ALLOW.some((re) => re.test("http://localhost.evil.example/cb"))).toBe(false);
  });

  test("ChatGPT registration accepts only its exact stable OAuth callback", () => {
    const callback = "https://chatgpt.com/connector_platform_oauth_redirect";
    expect(applyQuirks({ redirect_uris: [callback], application_type: "web" })).toEqual({
      redirect_uris: [callback],
      application_type: "web",
    });
    for (const redirect of [
      `${callback}/`,
      `${callback}?next=https://evil.example`,
      `${callback}#fragment`,
      callback.replace("https:", "http:"),
      callback.replace("chatgpt.com", "chatgpt.com.evil.example"),
      callback.replace("chatgpt.com", "evil.example@chatgpt.com"),
    ]) {
      expect(applyQuirks({ redirect_uris: [callback, redirect] })).toMatchObject({
        error: "invalid_redirect_uri",
      });
    }
  });

  test("registerBeforeHook rewrites the body or throws a 400", () => {
    expect(registerBeforeHook({ body: { redirect_uris: ["http://localhost:1/cb"] } })).toEqual({
      context: { body: { redirect_uris: ["http://localhost:1/cb"], application_type: "native" } },
    });
    expect(registerBeforeHook({ body: { client_name: "no uris" } })).toBeUndefined();
    expect(() =>
      registerBeforeHook({ body: { redirect_uris: ["https://evil.example/cb"] } }),
    ).toThrow(expect.objectContaining({ status: "BAD_REQUEST" }) as Error);
  });
});
