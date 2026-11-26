/**
 * Database strategy: ONE engine (Postgres semantics) in two hosts.
 *   postgres://...   -> `postgres` driver, the compose/prod path
 *   pglite://memory  -> @electric-sql/pglite in-process, the test/dev path (no Docker, no server)
 *   pglite:///path   -> PGlite persisted to a directory
 * Both run the same drizzle-kit migrations (services/auth/drizzle), so tests
 * exercise the real schema, the real Better Auth drizzle adapter and our own
 * tables with no second "memory store" implementation to keep in sync.
 *
 * `AuthDb` is the drizzle handle plus the small set of named queries the rest
 * of the service needs. Raw table access stays in this directory.
 */
import { fileURLToPath } from "node:url";
import {
  and,
  asc,
  count,
  countDistinct,
  desc,
  eq,
  gt,
  inArray,
  isNull,
  lt,
  max,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import type { PgDatabase, PgQueryResultHKT } from "drizzle-orm/pg-core";

import type { AdmittedVia, Verdict } from "../gate.ts";
import * as schema from "./schema.ts";

export type Drizzle = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface UserRow {
  readonly id: string;
  readonly name: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly mergedInto: string | null;
  readonly image: string | null;
  readonly githubId: string | null;
  readonly githubLogin: string | null;
  readonly feishuTenantKey: string | null;
  readonly feishuOpenId: string | null;
  readonly role: string | null;
  readonly banned: boolean;
  readonly admittedVia: AdmittedVia | null;
  readonly gateCheckedAt: number | null;
  readonly createdAt: Date;
}

export interface AuditInsert {
  readonly id: string;
  readonly at: Date;
  readonly type: string;
  readonly actorUserId: string | null;
  readonly subjectUserId: string | null;
  readonly clientId: string | null;
  readonly event: unknown;
}

export interface AuditRowRaw extends AuditInsert {
  readonly event: unknown;
}

/** The oauthClient columns first-party seeding reads back and reconciles (clients.ts). */
export interface ClientRow {
  readonly requirePKCE: boolean;
  readonly clientId: string;
  readonly name: string | null;
  readonly clientSecret: string | null;
  readonly redirectUris: readonly string[];
  readonly skipConsent: boolean;
  readonly tokenEndpointAuthMethod: string | null;
  readonly applicationType: string | null;
  readonly grantTypes: readonly string[];
  readonly metadata: Record<string, unknown> | null;
}

export type ClientPatch = {
  readonly disabled?: boolean;
  readonly requirePKCE?: boolean;
  readonly name?: string;
  readonly clientSecret?: string | null;
  readonly redirectUris?: readonly string[];
  readonly skipConsent?: boolean;
  readonly tokenEndpointAuthMethod?: string;
  readonly applicationType?: string;
  readonly grantTypes?: readonly string[];
  readonly metadata?: Record<string, unknown> | undefined;
};

/** Named queries over Better Auth's tables that other modules need. Keeps column names out of gate.ts/users.ts. */
export interface AuthQueries {
  readonly users: {
    byId(userId: string): Promise<UserRow | undefined>;
    byIds(userIds: readonly string[]): Promise<readonly UserRow[]>;
    byFeishu(tenantKey: string, openId: string): Promise<UserRow | undefined>;
    byGithubId(githubId: string): Promise<UserRow | undefined>;
    byLogin(githubLogin: string): Promise<UserRow | undefined>;
    imageOf(userId: string): Promise<string | null>;
    /** The only writer of admittedVia/gateCheckedAt. */
    writeGate(userId: string, verdict: Verdict, at: Date): Promise<void>;
    /** SELECT ... FOR UPDATE; call inside a transaction. */
    lock(userId: string): Promise<UserRow | undefined>;
    update(
      userId: string,
      patch: {
        githubConnectionOffered?: boolean;
        feishuTenantKey?: string;
        feishuOpenId?: string;
        githubId?: string;
        githubLogin?: string;
        email?: string;
        emailVerified?: boolean;
        name?: string;
        image?: string | null;
        role?: string;
        banned?: boolean;
        banReason?: string | null;
        banExpires?: Date | null;
      },
    ): Promise<void>;
    countActiveAdmins(): Promise<number>;
    /** Keyset page ordered by (createdAt desc, id desc). `after` is the previous page's last row. */
    page(query: {
      readonly search?: string;
      readonly after?: { readonly createdAt: Date; readonly id: string };
      readonly limit: number;
    }): Promise<readonly UserRow[]>;
  };
  readonly accounts: {
    feishuAccountId(userId: string): Promise<string | undefined>;
    /** account.accessToken for providerId "github"; null when the row is missing. */
    githubAccessToken(userId: string): Promise<string | null>;
  };
  readonly sessions: {
    deleteAllFor(userId: string): Promise<number>;
    lastCreatedFor(userIds: readonly string[]): Promise<ReadonlyMap<string, Date>>;
  };
  readonly tokens: {
    /** UPDATE oauthRefreshToken SET revoked = now WHERE userId = $1 AND revoked IS NULL. Returns count. */
    revokeAllRefreshTokens(userId: string): Promise<number>;
    revokeRefreshTokensFor(userId: string, clientId: string): Promise<number>;
    /** Distinct clients holding a live refresh token, per user. */
    liveClientCounts(userIds: readonly string[]): Promise<ReadonlyMap<string, number>>;
    /** Newest access token per client for one user. */
    lastIssuedByClient(userId: string): Promise<ReadonlyMap<string, Date>>;
  };
  readonly consents: {
    listFor(userId: string): Promise<
      readonly {
        readonly clientId: string;
        readonly clientName: string | null;
        readonly resources: readonly string[];
        readonly createdAt: Date;
      }[]
    >;
    deleteFor(userId: string, clientId: string): Promise<number>;
  };
  readonly clients: {
    byId(clientId: string): Promise<ClientRow | undefined>;
    insert(row: typeof schema.oauthClient.$inferInsert): Promise<void>;
    /** Every field first-party seeding reconciles. Absent keys are left alone; `metadata`/`clientSecret` may be set to null. */
    update(clientId: string, patch: ClientPatch): Promise<void>;
    /** Delete clients created before `olderThan` that own no consent and no live refresh token; never the `keep` ids or user-owned rows. */
    deleteIdle(olderThan: Date, keep: readonly string[]): Promise<readonly string[]>;
  };
  readonly feishuAllowlist: {
    has(tenantKey: string, openId: string): Promise<boolean>;
    list(): Promise<readonly (typeof schema.feishuAllowlist.$inferSelect)[]>;
    add(tenantKey: string, openId: string, note: string | null, addedBy: string): Promise<boolean>;
    remove(tenantKey: string, openId: string): Promise<boolean>;
  };
  readonly allowlist: {
    has(githubLogin: string): Promise<boolean>;
    list(): Promise<readonly (typeof schema.allowlist.$inferSelect)[]>;
    add(githubLogin: string, note: string | null, addedBy: string): Promise<boolean>;
    remove(githubLogin: string): Promise<boolean>;
  };
  readonly audit: {
    insert(row: AuditInsert): Promise<void>;
    /** Newest first; keyset on (at, id). */
    page(query: {
      readonly type?: string;
      readonly userId?: string;
      readonly after?: { readonly at: Date; readonly id: string };
      readonly limit: number;
    }): Promise<readonly AuditRowRaw[]>;
  };
}

export type AuthDb = Omit<Drizzle, "transaction"> &
  AuthQueries & {
    readonly host: "pglite" | "postgres";
    transaction<T>(fn: (tx: AuthDb) => Promise<T>): Promise<T>;
    close(): Promise<void>;
  };

const {
  user,
  session,
  account,
  oauthRefreshToken,
  oauthAccessToken,
  oauthConsent,
  oauthClient,
  allowlist,
  audit,
} = schema;

const USER_COLUMNS = {
  id: user.id,
  name: user.name,
  email: user.email,
  emailVerified: user.emailVerified,
  mergedInto: user.mergedInto,
  image: user.image,
  feishuTenantKey: user.feishuTenantKey,
  feishuOpenId: user.feishuOpenId,
  githubId: user.githubId,
  githubLogin: user.githubLogin,
  role: user.role,
  banned: user.banned,
  admittedVia: user.admittedVia,
  gateCheckedAt: user.gateCheckedAt,
  createdAt: user.createdAt,
};

function toUserRow(r: {
  id: string;
  name: string;
  email: string;
  emailVerified: boolean;
  mergedInto: string | null;
  image: string | null;
  githubId: string | null;
  githubLogin: string | null;
  feishuTenantKey: string | null;
  feishuOpenId: string | null;
  role: string | null;
  banned: boolean | null;
  admittedVia: string | null;
  gateCheckedAt: number | null;
  createdAt: Date;
}): UserRow {
  return { ...r, banned: r.banned === true, admittedVia: r.admittedVia as AdmittedVia | null };
}

function queries(d: Drizzle): AuthQueries {
  const oneUser = async (where: ReturnType<typeof eq>) =>
    (await d.select(USER_COLUMNS).from(user).where(where).limit(1)).map(toUserRow)[0];
  return {
    users: {
      byId: (id) => oneUser(eq(user.id, id)),
      byIds: async (ids) =>
        ids.length === 0
          ? []
          : (
              await d
                .select(USER_COLUMNS)
                .from(user)
                .where(inArray(user.id, [...ids]))
            ).map(toUserRow),
      byFeishu: (tenant, openId) =>
        oneUser(and(eq(user.feishuTenantKey, tenant), eq(user.feishuOpenId, openId))!),
      byGithubId: (githubId) => oneUser(eq(user.githubId, githubId)),
      byLogin: (login) => oneUser(sql`lower(${user.githubLogin}) = ${login.toLowerCase()}`),
      imageOf: async (id) =>
        (await d.select({ image: user.image }).from(user).where(eq(user.id, id)).limit(1))[0]
          ?.image ?? null,
      writeGate: async (id, verdict, at) => {
        await d
          .update(user)
          .set({
            admittedVia: verdict.ok ? verdict.via : null,
            gateCheckedAt: Math.floor(at.getTime() / 1000),
          })
          .where(eq(user.id, id));
      },
      lock: async (id) =>
        (await d.select(USER_COLUMNS).from(user).where(eq(user.id, id)).for("update")).map(
          toUserRow,
        )[0],
      update: async (id, patch) => {
        await d
          .update(user)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(user.id, id));
      },
      countActiveAdmins: async () =>
        (
          await d
            .select({ n: count() })
            .from(user)
            .where(and(eq(user.role, "admin"), or(isNull(user.banned), eq(user.banned, false))))
        )[0]?.n ?? 0,
      page: async ({ search, after, limit }) => {
        const conds = [];
        if (search) {
          const like = `%${search.toLowerCase()}%`;
          conds.push(
            or(sql`lower(${user.githubLogin}) like ${like}`, sql`lower(${user.name}) like ${like}`),
          );
        }
        if (after) {
          conds.push(
            or(
              lt(user.createdAt, after.createdAt),
              and(eq(user.createdAt, after.createdAt), lt(user.id, after.id)),
            ),
          );
        }
        return (
          await d
            .select(USER_COLUMNS)
            .from(user)
            .where(conds.length ? and(...conds) : undefined)
            .orderBy(desc(user.createdAt), desc(user.id))
            .limit(limit)
        ).map(toUserRow);
      },
    },
    accounts: {
      feishuAccountId: async (userId) =>
        (
          await d
            .select({ id: account.id })
            .from(account)
            .where(and(eq(account.userId, userId), eq(account.providerId, "feishu")))
            .limit(1)
        )[0]?.id,
      githubAccessToken: async (userId) =>
        (
          await d
            .select({ token: account.accessToken })
            .from(account)
            .where(and(eq(account.userId, userId), eq(account.providerId, "github")))
            .limit(1)
        )[0]?.token ?? null,
    },
    sessions: {
      deleteAllFor: async (userId) =>
        (await d.delete(session).where(eq(session.userId, userId)).returning({ id: session.id }))
          .length,
      lastCreatedFor: async (ids) => {
        if (ids.length === 0) return new Map();
        const rows = await d
          .select({ userId: session.userId, last: max(session.createdAt) })
          .from(session)
          .where(inArray(session.userId, [...ids]))
          .groupBy(session.userId);
        return new Map(rows.flatMap((r) => (r.last ? [[r.userId, r.last] as const] : [])));
      },
    },
    tokens: {
      revokeAllRefreshTokens: async (userId) =>
        (
          await d
            .update(oauthRefreshToken)
            .set({ revoked: new Date() })
            .where(and(eq(oauthRefreshToken.userId, userId), isNull(oauthRefreshToken.revoked)))
            .returning({ id: oauthRefreshToken.id })
        ).length,
      revokeRefreshTokensFor: async (userId, clientId) =>
        (
          await d
            .update(oauthRefreshToken)
            .set({ revoked: new Date() })
            .where(
              and(
                eq(oauthRefreshToken.userId, userId),
                eq(oauthRefreshToken.clientId, clientId),
                isNull(oauthRefreshToken.revoked),
              ),
            )
            .returning({ id: oauthRefreshToken.id })
        ).length,
      liveClientCounts: async (ids) => {
        if (ids.length === 0) return new Map();
        const rows = await d
          .select({
            userId: oauthRefreshToken.userId,
            n: countDistinct(oauthRefreshToken.clientId),
          })
          .from(oauthRefreshToken)
          .where(
            and(
              inArray(oauthRefreshToken.userId, [...ids]),
              isNull(oauthRefreshToken.revoked),
              gt(oauthRefreshToken.expiresAt, new Date()),
            ),
          )
          .groupBy(oauthRefreshToken.userId);
        return new Map(rows.flatMap((r) => (r.userId ? [[r.userId, r.n] as const] : [])));
      },
      lastIssuedByClient: async (userId) => {
        const rows = await d
          .select({ clientId: oauthAccessToken.clientId, last: max(oauthAccessToken.createdAt) })
          .from(oauthAccessToken)
          .where(eq(oauthAccessToken.userId, userId))
          .groupBy(oauthAccessToken.clientId);
        return new Map(rows.flatMap((r) => (r.last ? [[r.clientId, r.last] as const] : [])));
      },
    },
    consents: {
      listFor: async (userId) =>
        (
          await d
            .select({
              clientId: oauthConsent.clientId,
              clientName: oauthClient.name,
              resources: oauthConsent.resources,
              createdAt: oauthConsent.createdAt,
            })
            .from(oauthConsent)
            .leftJoin(oauthClient, eq(oauthClient.clientId, oauthConsent.clientId))
            .where(eq(oauthConsent.userId, userId))
            .orderBy(asc(oauthConsent.createdAt))
        ).map((r) => ({
          ...r,
          resources: r.resources ?? [],
          createdAt: r.createdAt ?? new Date(0),
        })),
      deleteFor: async (userId, clientId) =>
        (
          await d
            .delete(oauthConsent)
            .where(and(eq(oauthConsent.userId, userId), eq(oauthConsent.clientId, clientId)))
            .returning({ id: oauthConsent.id })
        ).length,
    },
    clients: {
      byId: async (clientId) => {
        const r = (
          await d
            .select({
              requirePKCE: oauthClient.requirePKCE,
              clientId: oauthClient.clientId,
              name: oauthClient.name,
              clientSecret: oauthClient.clientSecret,
              redirectUris: oauthClient.redirectUris,
              skipConsent: oauthClient.skipConsent,
              tokenEndpointAuthMethod: oauthClient.tokenEndpointAuthMethod,
              applicationType: oauthClient.applicationType,
              grantTypes: oauthClient.grantTypes,
              metadata: oauthClient.metadata,
            })
            .from(oauthClient)
            .where(eq(oauthClient.clientId, clientId))
            .limit(1)
        )[0];
        return r
          ? {
              requirePKCE: r.requirePKCE === true,
              clientId: r.clientId,
              name: r.name,
              clientSecret: r.clientSecret,
              redirectUris: r.redirectUris ?? [],
              skipConsent: r.skipConsent === true,
              tokenEndpointAuthMethod: r.tokenEndpointAuthMethod,
              applicationType: r.applicationType,
              grantTypes: r.grantTypes ?? [],
              metadata: (r.metadata as Record<string, unknown> | null) ?? null,
            }
          : undefined;
      },
      insert: async (row) => {
        await d.insert(oauthClient).values(row);
      },
      update: async (clientId, patch) => {
        await d
          .update(oauthClient)
          .set({
            disabled: patch.disabled,
            ...(patch.requirePKCE !== undefined ? { requirePKCE: patch.requirePKCE } : {}),
            ...(patch.name !== undefined ? { name: patch.name } : {}),
            ...("clientSecret" in patch ? { clientSecret: patch.clientSecret ?? null } : {}),
            ...(patch.redirectUris ? { redirectUris: [...patch.redirectUris] } : {}),
            ...(patch.skipConsent !== undefined ? { skipConsent: patch.skipConsent } : {}),
            ...(patch.tokenEndpointAuthMethod !== undefined
              ? { tokenEndpointAuthMethod: patch.tokenEndpointAuthMethod }
              : {}),
            ...(patch.applicationType !== undefined
              ? { applicationType: patch.applicationType }
              : {}),
            ...(patch.grantTypes ? { grantTypes: [...patch.grantTypes] } : {}),
            ...("metadata" in patch ? { metadata: patch.metadata ?? null } : {}),
            updatedAt: new Date(),
          })
          .where(eq(oauthClient.clientId, clientId));
      },
      deleteIdle: async (olderThan, keep) => {
        const consented = d.select({ clientId: oauthConsent.clientId }).from(oauthConsent);
        const live = d
          .select({ clientId: oauthRefreshToken.clientId })
          .from(oauthRefreshToken)
          .where(
            and(isNull(oauthRefreshToken.revoked), gt(oauthRefreshToken.expiresAt, new Date())),
          );
        const conds = [
          lt(oauthClient.createdAt, olderThan),
          isNull(oauthClient.userId),
          notInArray(oauthClient.clientId, consented),
          notInArray(oauthClient.clientId, live),
        ];
        if (keep.length > 0) conds.push(notInArray(oauthClient.clientId, [...keep]));
        const rows = await d
          .delete(oauthClient)
          .where(and(...conds))
          .returning({ clientId: oauthClient.clientId });
        return rows.map((r) => r.clientId);
      },
    },
    feishuAllowlist: {
      has: async (tenantKey, openId) =>
        (
          await d
            .select({ id: schema.feishuAllowlist.openId })
            .from(schema.feishuAllowlist)
            .where(
              and(
                eq(schema.feishuAllowlist.tenantKey, tenantKey),
                eq(schema.feishuAllowlist.openId, openId),
              ),
            )
            .limit(1)
        ).length > 0,
      list: () =>
        d.select().from(schema.feishuAllowlist).orderBy(asc(schema.feishuAllowlist.addedAt)),
      add: async (tenantKey, openId, note, addedBy) =>
        (
          await d
            .insert(schema.feishuAllowlist)
            .values({ tenantKey, openId, note, addedBy })
            .onConflictDoNothing()
            .returning()
        ).length > 0,
      remove: async (tenantKey, openId) =>
        (
          await d
            .delete(schema.feishuAllowlist)
            .where(
              and(
                eq(schema.feishuAllowlist.tenantKey, tenantKey),
                eq(schema.feishuAllowlist.openId, openId),
              ),
            )
            .returning()
        ).length > 0,
    },
    allowlist: {
      has: async (login) =>
        (
          await d
            .select({ l: allowlist.githubLogin })
            .from(allowlist)
            .where(eq(allowlist.githubLogin, login.toLowerCase()))
            .limit(1)
        ).length > 0,
      list: () => d.select().from(allowlist).orderBy(asc(allowlist.addedAt)),
      add: async (login, note, addedBy) =>
        (
          await d
            .insert(allowlist)
            .values({ githubLogin: login.toLowerCase(), note, addedBy })
            .onConflictDoNothing()
            .returning({ l: allowlist.githubLogin })
        ).length > 0,
      remove: async (login) =>
        (
          await d
            .delete(allowlist)
            .where(eq(allowlist.githubLogin, login.toLowerCase()))
            .returning({ l: allowlist.githubLogin })
        ).length > 0,
    },
    audit: {
      insert: async (row) => {
        await d.insert(audit).values({ ...row, event: row.event as Record<string, unknown> });
      },
      page: async ({ type, userId, after, limit }) => {
        const conds = [];
        if (type) conds.push(eq(audit.type, type));
        if (userId) conds.push(or(eq(audit.subjectUserId, userId), eq(audit.actorUserId, userId)));
        if (after)
          conds.push(
            or(lt(audit.at, after.at), and(eq(audit.at, after.at), lt(audit.id, after.id))),
          );
        return d
          .select()
          .from(audit)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(desc(audit.at), desc(audit.id))
          .limit(limit);
      },
    },
  };
}

function attach(d: Drizzle, host: AuthDb["host"], close: () => Promise<void>): AuthDb {
  const nativeTransaction = d.transaction.bind(d);
  const db = d as unknown as AuthDb;
  Object.assign(db, queries(d), {
    host,
    close,
    transaction: <T>(fn: (tx: AuthDb) => Promise<T>) =>
      nativeTransaction((tx) => fn(attach(tx as unknown as Drizzle, host, close))),
  });
  return db;
}

export async function createDb(databaseUrl: string): Promise<AuthDb> {
  if (databaseUrl.startsWith("pglite://")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle } = await import("drizzle-orm/pglite");
    const target = databaseUrl.slice("pglite://".length);
    const client = target === "memory" || target === "" ? new PGlite() : new PGlite(target);
    return attach(drizzle(client, { schema }) as unknown as Drizzle, "pglite", () =>
      client.close(),
    );
  }
  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    const { default: postgres } = await import("postgres");
    const { drizzle } = await import("drizzle-orm/postgres-js");
    const client = postgres(databaseUrl, { max: 5 });
    return attach(drizzle(client, { schema }) as unknown as Drizzle, "postgres", () =>
      client.end(),
    );
  }
  throw new TypeError(`DATABASE_URL: unsupported scheme in ${databaseUrl}`);
}

/**
 * Applies services/auth/drizzle/*.sql at boot. Drizzle's migrator records
 * applied files in `__drizzle_migrations` and runs each in a transaction; v1
 * runs one container, so no cross-process lock is taken.
 */
export async function migrate(
  db: AuthDb,
  migrationsFolder = defaultMigrationsFolder(),
): Promise<void> {
  if (db.host === "pglite") {
    const { migrate: run } = await import("drizzle-orm/pglite/migrator");
    await run(db as never, { migrationsFolder });
  } else {
    const { migrate: run } = await import("drizzle-orm/postgres-js/migrator");
    await run(db as never, { migrationsFolder });
  }
}

function defaultMigrationsFolder(): string {
  return process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL("../../drizzle", import.meta.url));
}
