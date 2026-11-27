import { and, eq } from "drizzle-orm";

import type { BbsDb } from "../db/index.ts";
import { resourceCatalog, resourcePages } from "../db/schema.ts";

export interface ResourceNode {
  id: string;
  title: string;
  children: ResourceNode[];
}

export interface ResourceCatalog {
  tree: ResourceNode[];
  syncedAt: string | null;
}

export interface ResourceAttachment {
  url: string;
  name: string;
}

export interface ResourcePage {
  id: string;
  title: string;
  html: string;
  attachments: ResourceAttachment[];
  updatedAt: string;
}

export async function getResourceCatalog(db: BbsDb): Promise<ResourceCatalog> {
  const [catalog] = await db.select().from(resourceCatalog).where(eq(resourceCatalog.id, 1));
  return catalog
    ? { tree: catalog.tree, syncedAt: catalog.syncedAt.toISOString() }
    : { tree: [], syncedAt: null };
}

export async function getResourcePage(db: BbsDb, id: string): Promise<ResourcePage | null> {
  const [page] = await db
    .select({
      id: resourcePages.id,
      title: resourcePages.title,
      html: resourcePages.html,
      attachments: resourcePages.attachments,
      updatedAt: resourcePages.updatedAt,
    })
    .from(resourcePages)
    .where(and(eq(resourcePages.id, id), eq(resourcePages.staged, false)));
  return page ? { ...page, updatedAt: page.updatedAt.toISOString() } : null;
}
