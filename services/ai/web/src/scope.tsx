/** The admin's "whose data" control. Members never see it; the server ignores scope for them. */
import { X } from "lucide-react";

import type { Person } from "./api.ts";
import { useMe, type ScopeSearch } from "./session.ts";
import { Segmented } from "./ui.tsx";

export function ScopeSwitch({
  search,
  onChange,
  people,
}: {
  search: ScopeSearch;
  onChange: (next: ScopeSearch) => void;
  people?: Record<string, Person>;
}) {
  const me = useMe();
  if (me.role !== "admin") return null;
  if (search.user)
    return (
      <span className="inline-flex h-8 items-center gap-1 rounded-md border border-line bg-surface pr-1 pl-2.5 text-xs">
        <span className="text-muted-foreground">User</span>
        <span className="max-w-40 truncate font-medium" title={search.user}>
          {people?.[search.user]?.displayName ?? search.user.slice(0, 12)}
        </span>
        <button
          type="button"
          aria-label="Clear user"
          className="grid size-5 place-items-center rounded text-muted-foreground hover:bg-surface-2 hover:text-foreground"
          onClick={() => onChange({ scope: "all", user: undefined })}
        >
          <X className="size-3" />
        </button>
      </span>
    );
  return (
    <Segmented
      label="Whose requests"
      value={search.scope === "all" ? "all" : "mine"}
      options={[
        { value: "mine", label: "Mine" },
        { value: "all", label: "Everyone" },
      ]}
      onChange={(v) => onChange({ scope: v === "all" ? "all" : undefined, user: undefined })}
    />
  );
}
