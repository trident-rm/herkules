/** The signed-in frame: sidebar navigation, theme switch, account, and the sign-in screen. */
import { Button } from "@herkules/ui/components/button";
import { cn } from "@herkules/ui/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { Link, Outlet, useRouterState } from "@tanstack/react-router";
import {
  Boxes,
  KeyRound,
  LayoutDashboard,
  LogOut,
  Menu,
  Monitor,
  Moon,
  ScrollText,
  Server,
  SlidersHorizontal,
  Sun,
  Terminal,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useState } from "react";

import { HttpError, type Me } from "./api.ts";
import { meQuery } from "./session.ts";
import { ErrorText, Muted } from "./ui.tsx";

interface NavItem {
  to: "/" | "/logs" | "/models" | "/keys" | "/setup" | "/admin/backends" | "/admin/logging";
  label: string;
  icon: LucideIcon;
}

const MAIN: NavItem[] = [
  { to: "/", label: "Overview", icon: LayoutDashboard },
  { to: "/logs", label: "Logs", icon: ScrollText },
  { to: "/models", label: "Models", icon: Boxes },
  { to: "/keys", label: "Keys", icon: KeyRound },
  { to: "/setup", label: "Setup", icon: Terminal },
];
const ADMIN: NavItem[] = [
  { to: "/admin/backends", label: "Backends", icon: Server },
  { to: "/admin/logging", label: "Logging", icon: SlidersHorizontal },
];

export function Root() {
  const me = useQuery(meQuery);
  if (me.isPending) return <Muted className="p-8">Loading…</Muted>;
  if (me.error instanceof HttpError && me.error.status === 401) return <SignIn />;
  if (me.error)
    return (
      <div className="p-8">
        <ErrorText error={me.error} />
      </div>
    );
  return <Frame me={me.data} />;
}

function Frame({ me }: { me: Me }) {
  const [open, setOpen] = useState(false);
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => setOpen(false), [path]);

  return (
    <div className="min-h-dvh md:grid md:grid-cols-[220px_minmax(0,1fr)]">
      <header className="sticky top-0 z-30 flex h-12 items-center gap-2 border-b border-line bg-surface px-3 md:hidden">
        <Button variant="ghost" size="icon" aria-label="Menu" onClick={() => setOpen(!open)}>
          {open ? <X /> : <Menu />}
        </Button>
        <Brand />
      </header>
      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex w-[220px] flex-col border-r border-line bg-surface transition-transform md:sticky md:top-0 md:h-dvh md:translate-x-0",
          open ? "translate-x-0" : "-translate-x-full",
        )}
      >
        <div className="hidden h-12 items-center px-4 md:flex">
          <Brand />
        </div>
        <nav className="flex-1 overflow-y-auto px-2 py-2">
          <NavGroup items={MAIN} />
          {me.role === "admin" && (
            <>
              <p className="mt-5 mb-1 px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
                Admin
              </p>
              <NavGroup items={ADMIN} />
            </>
          )}
        </nav>
        <div className="border-t border-line-2 p-2">
          <ThemeSwitch />
          <Account me={me} />
        </div>
      </aside>
      {open && (
        <div className="fixed inset-0 z-30 bg-black/30 md:hidden" onClick={() => setOpen(false)} />
      )}
      <main className="min-w-0 px-4 py-5 md:px-6">
        <Outlet />
      </main>
    </div>
  );
}

function Brand() {
  return (
    <Link to="/" className="flex items-center gap-2 font-semibold text-foreground">
      <span className="grid size-6 place-items-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
        H
      </span>
      Herkules AI
    </Link>
  );
}

function NavGroup({ items }: { items: NavItem[] }) {
  return (
    <ul className="m-0 grid list-none gap-0.5 p-0">
      {items.map(({ to, label, icon: Icon }) => (
        <li key={to}>
          <Link
            to={to}
            activeOptions={{ exact: to === "/", includeSearch: false }}
            className="flex h-8 items-center gap-2.5 rounded-md px-2 text-muted-foreground hover:bg-surface-2 hover:text-foreground"
            activeProps={{ className: "bg-surface-2 font-medium !text-foreground" }}
          >
            <Icon className="size-4" />
            {label}
          </Link>
        </li>
      ))}
    </ul>
  );
}

type Theme = "system" | "light" | "dark";
const THEMES: { value: Theme; icon: LucideIcon; label: string }[] = [
  { value: "system", icon: Monitor, label: "System theme" },
  { value: "light", icon: Sun, label: "Light theme" },
  { value: "dark", icon: Moon, label: "Dark theme" },
];

function storedTheme(): Theme {
  try {
    const t = localStorage.getItem("theme");
    return t === "light" || t === "dark" ? t : "system";
  } catch {
    return "system";
  }
}

/** Applies the saved theme; main.tsx calls it before the first render. */
export function applyTheme(theme: Theme = storedTheme()) {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

function ThemeSwitch() {
  const [theme, setTheme] = useState(storedTheme);
  return (
    <div className="mb-1 flex gap-0.5 px-1" role="radiogroup" aria-label="Theme">
      {THEMES.map(({ value, icon: Icon, label }) => (
        <button
          key={value}
          type="button"
          role="radio"
          aria-checked={theme === value}
          aria-label={label}
          title={label}
          className={cn(
            "grid size-7 place-items-center rounded-md text-muted-foreground hover:text-foreground",
            theme === value && "bg-surface-2 text-foreground",
          )}
          onClick={() => {
            setTheme(value);
            applyTheme(value);
            try {
              localStorage.setItem("theme", value);
            } catch {
              // Private windows may refuse storage; the theme still applies for this visit.
            }
          }}
        >
          <Icon className="size-3.5" />
        </button>
      ))}
    </div>
  );
}

function Account({ me }: { me: Me }) {
  return (
    <form method="post" action="/logout" className="flex items-center gap-2 rounded-md px-2 py-1.5">
      {me.avatarUrl ? (
        <img src={me.avatarUrl} alt="" className="size-6 rounded-full" />
      ) : (
        <span className="grid size-6 place-items-center rounded-full bg-surface-2 text-xs">
          {me.displayName.slice(0, 1)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-sm">{me.displayName}</span>
      <button
        type="submit"
        aria-label="Sign out"
        title="Sign out"
        className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-surface-2 hover:text-foreground"
      >
        <LogOut className="size-3.5" />
      </button>
    </form>
  );
}

function SignIn() {
  return (
    <div className="grid min-h-dvh place-items-center px-4">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6">
        <Brand />
        <p className="mt-3 text-muted-foreground">
          API keys for the team's models, with usage and request logs.
        </p>
        <Button asChild className="mt-5 w-full">
          <a href="/login">Sign in with Herkules</a>
        </Button>
      </div>
    </div>
  );
}
