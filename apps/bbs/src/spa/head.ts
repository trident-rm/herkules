/**
 * Server-side `<title>` / `og:*` injection for `/articles/:id` and `/kb/:name`.
 * Pure string work; the read that feeds it lives in static.ts.
 *
 * WHY A BOOT-TIME PARSE OF THE BUILT FILE, not a build-time template: Vite emits
 * hashed asset names, so the only document that references the right bundle is
 * the one Vite just produced. The server reads `${webDir}/index.html` once at
 * boot, splits it at the markers, and renders by concatenating three strings —
 * no per-request parse, no knowledge of asset names.
 *
 * THE CONTRACT with web/index.html (round 2), byte-for-byte and checked at boot:
 *
 *     <!--bbs:head-->
 *       <title>RM 文库</title> <meta name="description" …> …default og tags…
 *     <!--/bbs:head-->
 *
 * Everything between the markers is REPLACED, which is why the defaults live
 * inside them: the static file is a valid page on its own (what the Vite dev
 * server serves) and the server never merges tags. `loadHeadTemplate` THROWS on
 * a missing or misordered marker — a bad build is a container that will not
 * start, instead of a month of link previews saying "RM 文库".
 *
 * Escaping is the security boundary: an article title is forum content landing
 * inside an attribute value. `escapeAttribute` is the only way text enters the head.
 */
import { SITE_TITLE } from "../config.ts";
import { truncateChars } from "../content/text.ts";
import type { HeadMeta } from "../library/types.ts";

export const HEAD_OPEN = "<!--bbs:head-->";
export const HEAD_CLOSE = "<!--/bbs:head-->";
export const DESCRIPTION_CHARS = 200;

export interface HeadTemplate {
  /** `prefix + tags(meta) + suffix`. Cheap enough to run per request. */
  render(meta: HeadMeta, appOrigin: string): string;
  /** The file as built, markers included — served for every route with no metadata of its own. */
  readonly plain: string;
}

/** Throws a boot error naming the missing marker; never returns a template that silently does nothing. */
export function loadHeadTemplate(indexHtml: string): HeadTemplate {
  const a = indexHtml.indexOf(HEAD_OPEN);
  const b = indexHtml.indexOf(HEAD_CLOSE);
  if (a < 0) throw new Error(`index.html is missing the ${HEAD_OPEN} marker`);
  if (b < 0) throw new Error(`index.html is missing the ${HEAD_CLOSE} marker`);
  if (b < a) throw new Error(`index.html has ${HEAD_CLOSE} before ${HEAD_OPEN}`);
  const prefix = indexHtml.slice(0, a + HEAD_OPEN.length);
  const suffix = indexHtml.slice(b);
  return {
    plain: indexHtml,
    render: (meta, appOrigin) => `${prefix}\n${renderHeadTags(meta, appOrigin)}\n${suffix}`,
  };
}

/**
 * `<title>{title} · RM 文库</title>`, `<meta name=description>`, `<link rel=canonical>`,
 * and the og/twitter pairs rm-wenku emitted: og:type, og:title, og:description, og:url,
 * og:image, og:site_name, article:published_time, article:author, twitter:card.
 * Description whitespace-collapsed and cut at 200 chars; `og:url` = appOrigin + meta.path.
 */
export function renderHeadTags(meta: HeadMeta, appOrigin: string): string {
  const title = escapeAttribute(`${meta.title} · ${SITE_TITLE}`);
  const description = escapeAttribute(cutDescription(meta.description));
  const url = escapeAttribute(`${appOrigin.replace(/\/$/, "")}${meta.path}`);
  const lines = [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}">`,
    `<link rel="canonical" href="${url}">`,
    `<meta property="og:type" content="${meta.type}">`,
    `<meta property="og:title" content="${title}">`,
    `<meta property="og:description" content="${description}">`,
    `<meta property="og:url" content="${url}">`,
    `<meta property="og:site_name" content="${escapeAttribute(SITE_TITLE)}">`,
  ];
  if (meta.image) lines.push(`<meta property="og:image" content="${escapeAttribute(meta.image)}">`);
  if (meta.publishedAt) {
    lines.push(
      `<meta property="article:published_time" content="${meta.publishedAt.toISOString()}">`,
    );
  }
  if (meta.author) {
    lines.push(`<meta property="article:author" content="${escapeAttribute(meta.author)}">`);
  }
  lines.push(
    `<meta name="twitter:card" content="${meta.image ? "summary_large_image" : "summary"}">`,
  );
  return lines.join("\n");
}

function cutDescription(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  // Code-point, not UTF-16: a `slice` can end on a lone surrogate, which renders
  // as U+FFFD. `truncateChars` counts code points and appends the ellipsis.
  return truncateChars(collapsed, DESCRIPTION_CHARS - 1);
}

/**
 * Which detail URLs get real metadata. Everything else uses the site defaults.
 *
 * A `/kb/:name` that does not decode is neither: it names an id no document can
 * match, so it reports `undefined` and the caller answers 404. Collapsing it into
 * `null` (as this used to) made `/kb/%` a 200 with the site's own metadata — a
 * malformed URL advertised to crawlers as an existing document.
 */
export function headRouteOf(
  pathname: string,
): { kind: "article" | "entity" | "resource"; id: string } | null | undefined {
  const article = /^\/articles\/([^/]+)\/?$/.exec(pathname);
  if (article) return { kind: "article", id: article[1]! };
  const entity = /^\/kb\/([^/]+)\/?$/.exec(pathname);
  if (entity) {
    try {
      return { kind: "entity", id: decodeURIComponent(entity[1]!) };
    } catch {
      return undefined;
    }
  }
  const resource = /^\/resources\/([^/]+)\/?$/.exec(pathname);
  if (resource) return { kind: "resource", id: resource[1]! };
  return null;
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeAttribute(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ENTITIES[ch] ?? ch);
}
