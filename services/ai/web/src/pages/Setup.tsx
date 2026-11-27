import { useState } from "react";

import { snippets } from "../setup.ts";
import { useMe } from "../session.ts";
import { Code, CopyButton, PageHeader, Panel, Segmented } from "../ui.tsx";
import { newSecret } from "./Keys.tsx";

export function SetupPage() {
  const me = useMe();
  const [model, setModel] = useState(me.models[0] ?? "<model>");
  const level = me.logging.user ?? me.logging.models[model] ?? me.logging.default;
  return (
    <>
      <PageHeader title="Setup">
        {me.models.length > 1 && (
          <Segmented
            label="Model"
            value={model}
            options={me.models.map((m) => ({ value: m, label: m }))}
            onChange={setModel}
          />
        )}
      </PageHeader>
      <p className="mb-4 max-w-3xl text-sm text-muted-foreground">
        {newSecret
          ? "The snippets use the key you just created. "
          : "Create a key on the Keys page, then replace <your key>. "}
        Requests for {model} are logged at the{" "}
        <span className="font-medium text-foreground">{level}</span> level
        {level === "full"
          ? ", which stores request and response bodies that you and admins can read."
          : "."}
      </p>
      <div className="grid gap-4 xl:grid-cols-2">
        {snippets(me.apiOrigin, model, newSecret ?? "<your key>").map((s) => (
          <Panel
            key={s.id}
            title={
              <>
                {s.title} <span className="font-normal text-muted-foreground">· {s.file}</span>
              </>
            }
            action={<CopyButton text={s.text} />}
          >
            <Code className="border-0 bg-transparent p-0">{s.text}</Code>
          </Panel>
        ))}
      </div>
    </>
  );
}
