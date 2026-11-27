import { Button } from "@herkules/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { HttpError, api, type Me } from "./api.ts";
import { AdminPage } from "./pages/Admin.tsx";
import { KeysPage } from "./pages/Keys.tsx";
import { PerformancePage } from "./pages/Performance.tsx";
import { RequestsPage } from "./pages/Requests.tsx";
import { UsagePage } from "./pages/Usage.tsx";
import { ErrorText, Muted } from "./ui.tsx";

const TABS = [
  { id: "keys", title: "Keys" },
  { id: "usage", title: "Usage" },
  { id: "requests", title: "Requests" },
  { id: "performance", title: "Performance" },
  { id: "admin", title: "Admin" },
] as const;
type Tab = (typeof TABS)[number]["id"];

function tabFromHash(): Tab {
  const id = location.hash.slice(1);
  return TABS.some((t) => t.id === id) ? (id as Tab) : "keys";
}

export function App() {
  const me = useQuery({ queryKey: ["me"], queryFn: api.me });
  const [tab, setTab] = useState<Tab>(tabFromHash);
  useEffect(() => {
    const onHash = () => setTab(tabFromHash());
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  if (me.isPending)
    return (
      <Shell>
        <Muted>Loading…</Muted>
      </Shell>
    );
  if (me.error instanceof HttpError && me.error.status === 401) return <SignIn />;
  if (me.error)
    return (
      <Shell>
        <ErrorText error={me.error} />
      </Shell>
    );

  const tabs = TABS.filter((t) => t.id !== "admin" || me.data.role === "admin");
  return (
    <Shell me={me.data}>
      <nav className="mt-6 flex flex-wrap gap-1 border-b border-line">
        {tabs.map((t) => (
          <a
            key={t.id}
            href={`#${t.id}`}
            className={`-mb-px border-b-2 px-3 py-2 text-sm ${
              tab === t.id
                ? "border-primary font-medium"
                : "border-transparent text-muted-foreground"
            }`}
          >
            {t.title}
          </a>
        ))}
      </nav>
      {tab === "keys" && <KeysPage me={me.data} />}
      {tab === "usage" && <UsagePage />}
      {tab === "requests" && <RequestsPage me={me.data} />}
      {tab === "performance" && <PerformancePage />}
      {tab === "admin" && me.data.role === "admin" && <AdminPage />}
    </Shell>
  );
}

function Shell({ me, children }: { me?: Me; children: React.ReactNode }) {
  return (
    <div className="page mx-auto w-full max-w-6xl px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <p className="font-display text-2xl">Herkules AI</p>
        {me && (
          <form method="post" action="/logout" className="flex items-center gap-3">
            <span className="text-sm text-muted-foreground">
              {me.displayName}
              {me.role === "admin" ? " · admin" : ""}
            </span>
            <Button type="submit" variant="outline" size="sm">
              Sign out
            </Button>
          </form>
        )}
      </header>
      {children}
    </div>
  );
}

function SignIn() {
  return (
    <Shell>
      <div className="mt-16 max-w-md">
        <p className="lede">API keys for the team's models, usage and request logs.</p>
        <Button asChild className="mt-6">
          <a href="/login">Sign in with Herkules</a>
        </Button>
      </div>
    </Shell>
  );
}
