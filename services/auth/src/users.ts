/**
 * Users as the rest of herkules sees them: the user-info projection, and the
 * audited admin operations. This module is the ONLY writer of user.role,
 * user.banned, the allowlist table, and the "revoke everything for user X"
 * cutoff, and each write is an `Audited` transaction: the audit row commits
 * with the change or neither does.
 */
import type { Actor, Audit, AuditEvent, AuditPage, AuditType } from "./audit.ts";
import { decodeCursor, encodeCursor } from "./audit.ts";
import type { AuthDb, UserRow } from "./db/index.ts";
import type { AdmittedVia } from "./gate.ts";

/** A refused or impossible mutation. `status` maps straight to the HTTP response in app.ts. */
export class UsersError extends Error {
  readonly status: 403 | 404 | 409;
  readonly code: string;
  constructor(status: 403 | 404 | 409, code: string, message: string) {
    super(message);
    this.name = "UsersError";
    this.status = status;
    this.code = code;
  }
}

/** Mirrors packages/auth-middleware Role. Closed set; the admin plugin's comma-separated multi-role form is rejected at the boundary. */
export type Role = "admin" | "member";

/** Boundary: unknown DB row -> Role. Throws on anything but the two literals (fail closed: no token without a valid role). */
export function roleOf(row: Readonly<Record<string, unknown>>): Role {
  const role = row.role;
  if (role === "admin" || role === "member") return role;
  throw new Error(`user row has no valid role: ${JSON.stringify(role)}`);
}

/** What the user-info API returns. `avatarUrl` is OUR cached copy (avatars.ts), never GitHub's. */
export interface UserInfo {
  readonly id: string;
  readonly displayName: string;
  readonly avatarUrl: string;
  readonly githubId: string;
}

/** Admin list projection. Superset of UserInfo; never returned to non-admins. */
export interface AdminUserRow extends UserInfo {
  readonly githubLogin: string;
  readonly role: Role;
  readonly disabled: boolean;
  readonly admittedVia: AdmittedVia | null;
  readonly createdAt: Date;
  readonly lastLoginAt: Date | null; // max(session.createdAt)
  readonly connectedClients: number; // distinct clientId with a live refresh token
}

export interface AllowlistEntry {
  readonly githubLogin: string; // lower-cased; unique
  readonly note: string | null;
  readonly addedBy: string; // userId
  readonly addedAt: Date;
}

export interface ConnectedClient {
  readonly clientId: string;
  readonly name: string | null;
  readonly resources: readonly string[];
  readonly consentedAt: Date;
  readonly lastTokenAt: Date | null;
}

/** Result of an idempotent mutation: `changed: false` means the state already held; no audit row is written then. */
export type Mutation = { readonly changed: boolean };

export interface Users {
  /** Reads. Batch is bounded (≤ 100 ids); unknown ids are omitted, not errors. */
  info(id: string): Promise<UserInfo | undefined>;
  infoMany(ids: readonly string[]): Promise<readonly UserInfo[]>;
  /** Enabled = the user exists and is not disabled. Order follows `ids`; unknown ids are disabled. */
  accountStatus(ids: readonly string[]): Promise<readonly { id: string; enabled: boolean }[]>;
  /** The member directory: every non-disabled user, sorted by display name. Small team; bounded at 500. */
  directory(): Promise<readonly UserInfo[]>;

  /** The caller's own connected clients (settings page). */
  finishIdentitySetup(userId: string): Promise<void>;
  connectedClients(userId: string): Promise<readonly ConnectedClient[]>;

  /**
   * Disconnect one client from one user: delete the consent row AND revoke
   * every refresh token for (user, client). Better Auth's delete-consent
   * does only the first, which leaves the IDE logged in for 30 days.
   */
  revokeClient(actor: Actor, userId: string, clientId: string): Promise<Mutation>;

  /** Admin. */
  list(query: {
    readonly search?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }): Promise<{ readonly rows: readonly AdminUserRow[]; readonly next?: string }>;
  setRole(actor: Actor, userId: string, role: Role): Promise<Mutation>;
  /**
   * Disable = ONE transaction: user.banned = true (the admin plugin's session
   * hook now blocks logins; gate.recheck blocks refreshes), delete every
   * session row, revoke every refresh token row, insert the audit row.
   * Running it twice is a no-op with `changed: false`. Access tokens already
   * issued live out their ≤15 minutes (JWTs are unrevocable; FRAME accepts this).
   * An admin cannot disable themselves (last-admin lockout guard).
   */
  setDisabled(actor: Actor, userId: string, disabled: boolean, reason?: string): Promise<Mutation>;
  /** Kill browser sessions only (IDE refresh tokens survive). For "log them out everywhere" use setDisabled. */
  revokeSessions(actor: Actor, userId: string): Promise<{ readonly count: number }>;

  feishuAllowlist(): Promise<
    readonly (typeof import("./db/schema.ts").feishuAllowlist.$inferSelect)[]
  >;
  feishuAllowlistAdd(
    actor: Actor,
    tenantKey: string,
    openId: string,
    note?: string,
  ): Promise<Mutation>;
  feishuAllowlistRemove(actor: Actor, tenantKey: string, openId: string): Promise<Mutation>;
  allowlist(): Promise<readonly AllowlistEntry[]>;
  allowlistAdd(actor: Actor, githubLogin: string, note?: string): Promise<Mutation>;
  allowlistRemove(actor: Actor, githubLogin: string): Promise<Mutation>;

  audit(query: {
    readonly cursor?: string;
    readonly limit?: number;
    readonly type?: AuditType;
    readonly userId?: string;
  }): Promise<AuditPage>;

  /** Called from the login after-hook: avatar refresh. Nothing role-related happens at login. */
  onLogin(userId: string): Promise<void>;

  /**
   * Boot-time seed: promote every existing user whose login is in ADMIN_GITHUB_LOGINS
   * and is not admin (audit `admin.seeded`, actor system). NEVER demotes — the env
   * is a seed and the `user.role` column owns the role after that. Idempotent; this
   * is also the operator recovery path (add the login, restart).
   */
  reconcileEnvAdmins(): Promise<void>;
}

export interface UsersDeps {
  readonly db: AuthDb;
  readonly audit: Audit;
  readonly avatarUrlFor: (userId: string) => string;
  readonly refreshAvatar: (userId: string) => Promise<void>;
  readonly adminGithubLogins: readonly string[];
  readonly now: () => Date;
}

/**
 * Every mutation is written as `db.transaction(tx => { ...change...; await audit.record(event, tx) })`.
 * The helper below is the only way to get a `tx` in this module, so a change
 * without an event does not type-check: `audited(actor, change)` requires
 * `change` to return the AuditEvent it justifies (or undefined for a no-op).
 */
export function createUsers(deps: UsersDeps): Users {
  const { db, audit, avatarUrlFor, refreshAvatar, adminGithubLogins } = deps;
  const infoOf = (u: UserRow): UserInfo => ({
    id: u.id,
    displayName: u.name,
    avatarUrl: avatarUrlFor(u.id),
    githubId: u.githubId ?? "",
  });
  /** Display role: a row without a valid role is shown as member; tokens still use the strict roleOf. */
  const displayRole = (u: UserRow): Role => (u.role === "admin" ? "admin" : "member");

  /** The only way to get a `tx` here: a change must return the event that justifies it (or undefined for a no-op). */
  const audited = (fn: (tx: AuthDb) => Promise<AuditEvent | undefined>): Promise<Mutation> =>
    db.transaction(async (tx) => {
      const event = await fn(tx);
      if (event) await audit.record(event, tx);
      return { changed: event !== undefined };
    });

  const mustLock = async (tx: AuthDb, userId: string): Promise<UserRow> => {
    const u = await tx.users.lock(userId);
    if (!u) throw new UsersError(404, "user_not_found", "no such user");
    return u;
  };

  return {
    async info(id) {
      const u = await db.users.byId(id);
      return u ? infoOf(u) : undefined;
    },
    async accountStatus(ids) {
      const rows = new Map((await db.users.byIds(ids)).map((row) => [row.id, row]));
      return ids.map((id) => ({ id, enabled: rows.get(id)?.banned === false }));
    },
    async infoMany(ids) {
      const unique = [...new Set(ids)].slice(0, 100);
      return (await db.users.byIds(unique)).map(infoOf);
    },
    async directory() {
      const rows = await db.users.page({ limit: 500 });
      return rows
        .filter((u) => !u.banned)
        .map(infoOf)
        .sort((x, y) => x.displayName.localeCompare(y.displayName) || x.id.localeCompare(y.id));
    },

    finishIdentitySetup: (userId) => db.users.update(userId, { githubConnectionOffered: true }),
    async connectedClients(userId) {
      const [consents, lastByClient] = await Promise.all([
        db.consents.listFor(userId),
        db.tokens.lastIssuedByClient(userId),
      ]);
      return consents.map((c) => ({
        clientId: c.clientId,
        name: c.clientName,
        resources: c.resources,
        consentedAt: c.createdAt,
        lastTokenAt: lastByClient.get(c.clientId) ?? null,
      }));
    },

    revokeClient: (actor, userId, clientId) =>
      audited(async (tx) => {
        const consents = await tx.consents.deleteFor(userId, clientId);
        const tokens = await tx.tokens.revokeRefreshTokensFor(userId, clientId);
        return consents + tokens > 0
          ? { type: "client.revoked", actor, userId, clientId }
          : undefined;
      }),

    async list(query) {
      const limit = Math.min(Math.max(query.limit ?? 50, 1), 100);
      const cursor = decodeCursor(query.cursor);
      const page = await db.users.page({
        search: query.search,
        after: cursor ? { createdAt: cursor.at, id: cursor.id } : undefined,
        limit: limit + 1,
      });
      const users = page.slice(0, limit);
      const ids = users.map((u) => u.id);
      const [lastLogin, clients] = await Promise.all([
        db.sessions.lastCreatedFor(ids),
        db.tokens.liveClientCounts(ids),
      ]);
      const rows = users.map((u): AdminUserRow => ({
        ...infoOf(u),
        githubLogin: u.githubLogin ?? "",
        role: displayRole(u),
        disabled: u.banned,
        admittedVia: u.admittedVia,
        createdAt: u.createdAt,
        lastLoginAt: lastLogin.get(u.id) ?? null,
        connectedClients: clients.get(u.id) ?? 0,
      }));
      const last = users.at(-1);
      return page.length > limit && last
        ? { rows, next: encodeCursor(last.createdAt, last.id) }
        : { rows };
    },

    setRole: (actor, userId, role) =>
      audited(async (tx) => {
        const u = await mustLock(tx, userId);
        const previous = displayRole(u);
        if (previous === role) return undefined;
        if (previous === "admin" && !u.banned && (await tx.users.countActiveAdmins()) <= 1) {
          throw new UsersError(409, "last_admin", "cannot demote the last admin");
        }
        /**
         * Losing your own admin is not undoable by you. Checked AFTER last_admin
         * on purpose: an admin demoting another admin always leaves two active
         * admins, so last_admin is reachable only through this same call, and
         * reversing the order would make it dead code. A system actor (a job)
         * still passes both.
         */
        if (role !== "admin" && actor.kind === "user" && actor.userId === userId) {
          throw new UsersError(403, "self_demote", "cannot demote yourself");
        }
        await tx.users.update(userId, { role });
        return { type: "admin.role_set", actor, userId, role, previous };
      }),

    setDisabled: (actor, userId, disabled, reason) =>
      audited(async (tx) => {
        if (disabled && actor.kind === "user" && actor.userId === userId) {
          throw new UsersError(403, "self_disable", "cannot disable yourself");
        }
        const u = await mustLock(tx, userId);
        if (u.mergedInto && !disabled)
          throw new UsersError(409, "account_merged", "A merged account cannot be re-enabled.");
        if (u.banned === disabled) return undefined;
        if (disabled) {
          if (displayRole(u) === "admin" && (await tx.users.countActiveAdmins()) <= 1) {
            throw new UsersError(409, "last_admin", "cannot disable the last admin");
          }
          await tx.users.update(userId, {
            banned: true,
            banReason: reason ?? null,
            banExpires: null,
          });
          const sessionsRevoked = await tx.sessions.deleteAllFor(userId);
          const refreshTokensRevoked = await tx.tokens.revokeAllRefreshTokens(userId);
          return {
            type: "admin.user_disabled",
            actor,
            userId,
            ...(reason ? { reason } : {}),
            refreshTokensRevoked,
            sessionsRevoked,
          };
        }
        await tx.users.update(userId, { banned: false, banReason: null, banExpires: null });
        return { type: "admin.user_enabled", actor, userId };
      }),

    async revokeSessions(actor, userId) {
      let count = 0;
      await audited(async (tx) => {
        await mustLock(tx, userId);
        count = await tx.sessions.deleteAllFor(userId);
        return count > 0 ? { type: "admin.sessions_revoked", actor, userId, count } : undefined;
      });
      return { count };
    },

    feishuAllowlist: () => db.feishuAllowlist.list(),
    feishuAllowlistAdd: (actor, tenantKey, openId, note) =>
      audited(async (tx) => {
        if (![tenantKey, openId].every((id) => /^[A-Za-z0-9_-]{1,128}$/.test(id)))
          throw new UsersError(
            409,
            "invalid_feishu_identity",
            "Enter a Feishu tenant key and app-scoped open ID.",
          );
        const addedBy = actor.kind === "user" ? actor.userId : `system:${actor.job}`;
        const added = await tx.feishuAllowlist.add(tenantKey, openId, note ?? null, addedBy);
        return added
          ? {
              type: "admin.feishu_allowlist_added",
              actor,
              tenantKey,
              openId,
              ...(note ? { note } : {}),
            }
          : undefined;
      }),
    feishuAllowlistRemove: (actor, tenantKey, openId) =>
      audited(async (tx) => {
        const removed = await tx.feishuAllowlist.remove(tenantKey, openId);
        return removed
          ? { type: "admin.feishu_allowlist_removed", actor, tenantKey, openId }
          : undefined;
      }),
    allowlist: () => db.allowlist.list(),
    allowlistAdd: (actor, githubLogin, note) =>
      audited(async (tx) => {
        const login = githubLogin.trim().toLowerCase();
        if (!/^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,38}$/.test(login)) {
          throw new UsersError(409, "invalid_login", "not a GitHub login");
        }
        const addedBy = actor.kind === "user" ? actor.userId : `system:${actor.job}`;
        const added = await tx.allowlist.add(login, note ?? null, addedBy);
        return added
          ? { type: "admin.allowlist_added", actor, githubLogin: login, ...(note ? { note } : {}) }
          : undefined;
      }),
    allowlistRemove: (actor, githubLogin) =>
      audited(async (tx) => {
        const login = githubLogin.trim().toLowerCase();
        const removed = await tx.allowlist.remove(login);
        return removed ? { type: "admin.allowlist_removed", actor, githubLogin: login } : undefined;
      }),

    audit: (query) => audit.list(query),

    onLogin: (userId) => refreshAvatar(userId),

    async reconcileEnvAdmins() {
      for (const login of adminGithubLogins) {
        const row = await db.users.byLogin(login);
        if (!row || row.role === "admin") continue;
        await audited(async (tx) => {
          const u = await mustLock(tx, row.id);
          if (u.role === "admin") return undefined;
          await tx.users.update(u.id, { role: "admin" });
          return { type: "admin.seeded", userId: u.id, githubLogin: u.githubLogin ?? "" };
        });
      }
    },
  };
}
