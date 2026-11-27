import { useSuspenseQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import type { ResourceNode, ResourcePage } from "../../../src/library/resources.ts";
import { formatDate } from "../lib/format.ts";
import { Lightbox } from "../reader/Lightbox.tsx";
import { Prose } from "../reader/Prose.tsx";
import { resourceRoute, resourcesRoute } from "../routes.tsx";
import { NotFound } from "../shell/NotFound.tsx";
import { usePageTitle } from "../shell/usePageTitle.ts";

const TITLE = "规则与资料";
const SOURCE = "https://bbs.robomaster.com/wiki/20204847";

function findPath(nodes: ResourceNode[], id: string): ResourceNode[] | null {
  for (const node of nodes) {
    if (node.id === id) return [node];
    const path = findPath(node.children, id);
    if (path) return [node, ...path];
  }
  return null;
}

function PageList({ nodes }: { nodes: ResourceNode[] }) {
  return (
    <ul className="divide-y divide-line">
      {nodes.map((node) => (
        <li key={node.id}>
          <Link
            className="block py-2.5 text-sm text-ink-2 hover:text-accent"
            to="/resources/$id"
            params={{ id: node.id }}
          >
            {node.title}
          </Link>
        </li>
      ))}
    </ul>
  );
}

export function ResourceDirectory() {
  const { q } = resourcesRoute.useRouteContext();
  const { data: catalog } = useSuspenseQuery(q.resourceCatalog());
  usePageTitle(TITLE);

  return (
    <div className="page py-10 [--measure:1100px]">
      <h1 className="page-title mb-3">{TITLE}</h1>
      <p className="mb-8 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
        <a className="text-accent" href={SOURCE}>
          RoboMaster 官方资料中心 ↗
        </a>
        {catalog.syncedAt && (
          <span>
            最近同步 <time dateTime={catalog.syncedAt}>{formatDate(catalog.syncedAt)}</time>
          </span>
        )}
      </p>
      {catalog.tree.length === 0 ? (
        <p className="rounded-lg border border-line bg-surface p-5 text-ink-2">等待首次同步。</p>
      ) : (
        <div className="grid items-start gap-5 lg:grid-cols-3">
          {catalog.tree.map((branch) => (
            <section key={branch.id} className="rounded-lg border border-line bg-surface p-5">
              <h2 className="mb-1 text-lg font-semibold">
                <Link
                  className="text-ink hover:text-accent"
                  to="/resources/$id"
                  params={{ id: branch.id }}
                >
                  {branch.title}
                </Link>
              </h2>
              <PageList nodes={branch.children} />
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

export function ResourceReader() {
  const { id } = resourceRoute.useParams();
  const { q } = resourceRoute.useRouteContext();
  const { data: catalog } = useSuspenseQuery(q.resourceCatalog());
  const { data: page } = useSuspenseQuery(q.resourcePage(id));
  usePageTitle(page?.title ?? null);
  if (!page) return <NotFound />;

  const path = findPath(catalog.tree, id);
  const children = path?.at(-1)?.children ?? [];
  return (
    <div className="page py-8 [--measure:960px]">
      <nav aria-label="资料路径" className="mb-4 text-sm text-muted-foreground">
        <ol className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <li>
            <Link to="/resources">{TITLE}</Link>
          </li>
          {path?.slice(0, -1).map((node) => (
            <li key={node.id}>
              <span aria-hidden="true" className="mr-2">
                /
              </span>
              <Link to="/resources/$id" params={{ id: node.id }}>
                {node.title}
              </Link>
            </li>
          ))}
        </ol>
      </nav>
      <article className="min-w-0">
        <h1 className="page-title mb-3">{page.title}</h1>
        <p className="mb-7 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-muted-foreground">
          <span>
            原文更新 <time dateTime={page.updatedAt}>{formatDate(page.updatedAt)}</time>
          </span>
          <a className="text-accent" href={`${SOURCE}/${page.id}`}>
            RoboMaster 原文 ↗
          </a>
        </p>
        {children.length > 0 && (
          <nav aria-label="下级资料" className="mb-7 rounded-lg border border-line bg-surface px-4">
            <PageList nodes={children} />
          </nav>
        )}
        <ResourceBody key={page.id} page={page} />
        {page.attachments.length > 0 && (
          <section className="mt-6 border-t border-line pt-4">
            <h2 className="mb-2 text-base font-semibold">附件</h2>
            <ul className="space-y-2 break-words text-sm">
              {page.attachments.map((file) => (
                <li key={file.url}>
                  <a className="text-accent" href={file.url} target="_blank" rel="noreferrer">
                    {file.name}
                  </a>
                </li>
              ))}
            </ul>
          </section>
        )}
      </article>
    </div>
  );
}

function ResourceBody({ page }: { page: ResourcePage }) {
  const [image, setImage] = useState<{ src: string; alt: string } | null>(null);
  return (
    <>
      <Prose html={page.html} onImage={(src, alt) => setImage({ src, alt })} />
      <Lightbox src={image?.src ?? null} alt={image?.alt ?? ""} onClose={() => setImage(null)} />
    </>
  );
}
