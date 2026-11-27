import { useCallback, type MouseEvent } from "react";

/** A link that is an image wrapper, not a destination, still opens the lightbox. */
const IMAGE_URL = /\.(png|jpe?g|gif|webp|avif|bmp|svg)(\?|#|$)/i;

/**
 * The article body. The HTML was sanitised at import and post-processed by
 * `prepareProse`, so it is injected as-is; the only behaviour added here is one
 * delegated click handler, which is why there are no per-node React elements:
 *
 *  - a link into this library (`prepareProse` already rewrote its href to
 *    `/articles/…`) goes through the router instead of reloading the page,
 *  - an image opens the lightbox.
 *
 * Modified clicks (new tab, download) are left to the browser.
 */
export function Prose({
  html,
  onNavigate,
  onImage,
}: {
  html: string;
  onNavigate?: (path: string) => void;
  onImage: (src: string, alt: string) => void;
}) {
  const onClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const target = event.target as Element;

      const img = target.closest("img");
      if (img) {
        const wrapper = img.closest("a");
        // A picture linking somewhere else is a link first, a picture second.
        if (!wrapper || wrapper.href === img.currentSrc || IMAGE_URL.test(wrapper.href)) {
          event.preventDefault();
          onImage(img.currentSrc || img.src, img.alt || img.title || "");
          return;
        }
      }

      const anchor = target.closest("a");
      if (!anchor?.href || !onNavigate) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (!url.pathname.startsWith("/articles/")) return;
      event.preventDefault();
      onNavigate(url.pathname);
    },
    [onNavigate, onImage],
  );

  return <div className="prose" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}
