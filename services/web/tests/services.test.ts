import { describe, expect, it } from "vite-plus/test";

import type { Service } from "../src/services.ts";
import { SERVICES, serviceHref } from "../src/services.ts";

const byId = (id: string): Service => {
  const service = SERVICES.find((s) => s.id === id);
  if (!service) throw new Error(`no service ${id}`);
  return service;
};

describe("serviceHref", () => {
  it("is a subdomain of whatever origin the browser is on", () => {
    const here = new URL("https://herkules.dev/");
    expect(serviceHref(byId("bbs"), here)).toBe("https://bbs.herkules.dev/");
    expect(serviceHref(byId("status"), here)).toBe("https://status.herkules.dev/");
    expect(serviceHref(byId("ops"), here)).toBe("https://ops.herkules.dev/");
    expect(serviceHref(byId("ai"), here)).toBe("https://ai-portal.herkules.dev/");
  });

  it("follows the origin to another domain, so a deploy needs no rebuild", () => {
    expect(serviceHref(byId("bbs"), new URL("https://example.test/"))).toBe(
      "https://bbs.example.test/",
    );
  });

  it("uses the dev port where vite serves the SPA, and the Caddyfile's *.localhost otherwise", () => {
    const dev = new URL("http://localhost:3000/");
    expect(serviceHref(byId("bbs"), dev)).toBe("http://localhost:3003/");
    expect(serviceHref(byId("status"), dev)).toBe("http://status.localhost/");
    expect(serviceHref(byId("ops"), dev)).toBe("http://ops.localhost/");
    expect(serviceHref(byId("ai"), dev)).toBe("http://localhost:4010/");
  });

  it("lists every public service before the gated ones", () => {
    const gated = SERVICES.findIndex((s) => s.access === "member");
    expect(SERVICES.slice(0, gated).every((s) => s.access === "public")).toBe(true);
  });
});
