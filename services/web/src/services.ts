/**
 * The services the platform hosts, as the landing page lists them.
 *
 * Checked in here rather than derived from `services/auth/src/registry.ts`:
 * that registry owns OAuth audiences, and status and ops are not resources —
 * they are sites, with no token and no `aud`. Adding one here is a line and a
 * deploy; adding one there is a security boundary.
 *
 * Hosts are subdomains of whatever origin the browser is on, so the built
 * bundle carries no hostname and a deploy to a different domain needs no
 * rebuild — the same rule `api.ts` follows for the auth service.
 */

export interface Service {
  readonly id: string;
  readonly title: string;
  readonly blurb: string;
  /** Subdomain of the current origin: "bbs" -> https://bbs.herkules.dev/. */
  readonly sub: string;
  /** Where `vp run dev` serves it, when that is a port on localhost rather than a `*.localhost` host. */
  readonly devPort?: number;
  /**
   * "public": anyone may open it.
   * "member": its own sign-in gates it, so the card is blurred until you have a
   * session here. The blur is a signpost, NOT a boundary — ops.herkules.dev is
   * gated by Beszel's herkules-OIDC sign-in, which any member passes.
   */
  readonly access: "public" | "member";
}

export const SERVICES: readonly Service[] = [
  {
    id: "bbs",
    title: "RM 文库",
    blurb:
      "The RoboMaster article archive: full text, tags, trigram search, and a read-only MCP server.",
    sub: "bbs",
    devPort: 3003,
    access: "public",
  },
  {
    id: "status",
    title: "Status",
    blurb: "Uptime and response times for every public endpoint, checked continuously.",
    sub: "status",
    access: "public",
  },
  {
    id: "ops",
    title: "Ops",
    blurb: "Host metrics for the box and the team's NUCs — CPU, memory, disk, containers.",
    sub: "ops",
    access: "member",
  },
];

/**
 * `location` is read here, not at module load, so the constant above stays a
 * pure value and this stays the one testable seam.
 */
export function serviceHref(service: Service, origin: Location | URL = location): string {
  const { protocol, hostname } = origin;
  if (hostname === "localhost" || hostname.endsWith(".localhost")) {
    return service.devPort
      ? `http://localhost:${service.devPort}/`
      : `${protocol}//${service.sub}.localhost/`;
  }
  return `${protocol}//${service.sub}.${hostname}/`;
}
