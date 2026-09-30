import { Button } from "@herkules/ui/components/button";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { ArticleDTO } from "../../../src/api/dto.ts";
import { linkKindText } from "../lib/format.ts";

type ArticleLink = ArticleDTO["links"][number];

/** The first five links; the rest are one click away. */
const PREVIEW = 5;

/** Host + path reads better than a bare URL when the crawler found no label. */
function label(link: ArticleLink): string {
  if (link.label && link.label !== link.url) return link.label;
  try {
    const url = new URL(link.url);
    return `${url.host}${url.pathname === "/" ? "" : url.pathname}`;
  } catch {
    return link.url;
  }
}

/**
 * Outbound links and the article's images. A link whose target is in this
 * library is a router link (`articleId`), everything else leaves the site.
 * Images are listed by caption and open in a new tab rather than the reader's
 * lightbox: the lightbox belongs to the body, and a sidebar thumbnail grid at
 * ≤ 960 px would push the sheet's real content off screen.
 */
const LINK =
  "min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-ink-2 hover:text-accent";

export function Resources({
  links,
  images,
}: {
  links: ArticleDTO["links"];
  images: ArticleDTO["images"];
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? links : links.slice(0, PREVIEW);
  const hidden = links.length - shown.length;

  if (links.length === 0 && images.length === 0) return null;

  return (
    <>
      {shown.length > 0 && (
        <div className="flex flex-col">
          {shown.map((link) => (
            <div
              className="flex items-start gap-2.5 border-t border-line-2 py-2.5 text-sm last:border-b"
              key={link.url}
            >
              <span className="mt-0.5 rounded-[3px] border border-line px-1.5 py-px font-mono text-[11px] whitespace-nowrap text-muted-foreground">
                {link.articleId ? "本站" : linkKindText(link.kind)}
              </span>
              {link.articleId ? (
                <Link
                  className={LINK}
                  to="/articles/$id"
                  params={{ id: link.articleId }}
                  title={link.url}
                >
                  {label(link)}
                </Link>
              ) : (
                <a
                  className={LINK}
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  title={link.url}
                >
                  {label(link)}
                </a>
              )}
            </div>
          ))}
        </div>
      )}
      {hidden > 0 && (
        <Button
          variant="link"
          className="h-auto justify-start self-start px-0 pt-2.5 text-[13px] text-muted-foreground hover:text-accent"
          type="button"
          onClick={() => setExpanded(true)}
        >
          还有 {hidden} 个链接
        </Button>
      )}
      {images.length > 0 && (
        <div className="mt-3 flex flex-col gap-1.5">
          <span className="label">原文图片 {images.length}</span>
          <ol className="m-0 list-decimal pl-5 text-[13px] leading-[1.7] text-ink-2 [&_a]:text-ink-2 [&_a:hover]:text-accent">
            {images.map((image, index) => (
              <li key={image.url}>
                <a href={image.url} target="_blank" rel="noopener noreferrer">
                  {image.alt ?? `图片 ${index + 1}`}
                </a>
              </li>
            ))}
          </ol>
        </div>
      )}
    </>
  );
}
