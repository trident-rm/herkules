import { describe, expect, it } from "vite-plus/test";

import { query } from "../web/src/api.ts";
import { count, ms, percent, shortRoute } from "../web/src/format.ts";
import { toScope } from "../web/src/session.ts";
import { outcome } from "../web/src/outcome.ts";
import type { Me } from "../web/src/api.ts";

describe("format", () => {
  it("abbreviates large counts and keeps small ones exact", () => {
    expect(count(950)).toBe("950");
    expect(count(12_345)).toBe("12.3K");
    expect(count(2_500_000)).toBe("2.50M");
    expect(count(null)).toBe("–");
    expect(ms(250.4)).toBe("250 ms");
    expect(ms(1520)).toBe("1.52 s");
  });

  it("formats shares and routes", () => {
    expect(percent(1, 4)).toBe("25%");
    expect(percent(1, 3000)).toBe("<0.1%");
    expect(percent(0, 0)).toBe("–");
    expect(shortRoute("/v1/chat/completions")).toBe("chat/completions");
    expect(shortRoute("/tokenize")).toBe("tokenize");
  });
});

describe("query", () => {
  it("drops empty values", () => {
    expect(query({ q: "", all: false, sub: undefined, key: 3, range: "24h", before: 0 })).toBe(
      "key=3&range=24h&before=0",
    );
  });
});

describe("scope", () => {
  const me = (role: Me["role"]) => ({ role }) as Me;
  it("gives members their own data whatever the URL says", () => {
    expect(toScope({ scope: "all", user: "x" }, me("member"))).toEqual({});
  });
  it("lets admins pick everyone or one member", () => {
    expect(toScope({ scope: "all" }, me("admin"))).toEqual({ all: true });
    expect(toScope({ scope: "all", user: "x" }, me("admin"))).toEqual({ sub: "x" });
    expect(toScope({}, me("admin"))).toEqual({});
  });
});

describe("outcome", () => {
  it("matches the server's status filter", () => {
    expect(outcome({ status: 200, error: null, cancelled: false })).toBe("ok");
    expect(outcome({ status: 200, error: "boom", cancelled: false })).toBe("error");
    expect(outcome({ status: 502, error: null, cancelled: false })).toBe("error");
    expect(outcome({ status: 499, error: null, cancelled: true })).toBe("cancelled");
  });
});
