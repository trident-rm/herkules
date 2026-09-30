import { Card } from "@herkules/ui/components/card";
import { Disclosure } from "../shell/Disclosure.tsx";
import type { ArticleAiDTO } from "../../../src/api/dto.ts";
import { maturityClass, sectionLabels } from "../lib/ai.ts";

type Overview = NonNullable<ArticleAiDTO["overview"]>;

const CARD = "flex flex-col gap-3 rounded-lg border border-line bg-surface px-[18px] pt-4 pb-3.5";
const P = "m-0 text-sm leading-[1.7] text-ink-2";
const UL = "m-0 list-disc pl-5 text-sm leading-[1.7] text-ink-2";
const OL = "m-0 list-decimal pl-5 text-sm leading-[1.7] text-ink-2";
/** A section label; pulled up so the list under it reads as its own. */
const LABEL = "label -mb-1.5";
const CHECKLIST = `${UL} list-none pl-0 [&_li]:relative [&_li]:pl-5 [&_li]:before:absolute [&_li]:before:top-2 [&_li]:before:left-0.5 [&_li]:before:size-2 [&_li]:before:rounded-[2px] [&_li]:before:border-[1.5px] [&_li]:before:border-muted-foreground [&_li]:before:content-['']`;
const FINE = "text-xs font-normal text-muted-foreground";

/**
 * The AI overview card. `status` is the whole state machine — there is no
 * polling and no refresh button: the generator runs on another box, so a
 * `pending` row is a fact to report, not something this page can wait for.
 */
export function AiOverview({ ai }: { ai: ArticleAiDTO }) {
  switch (ai.status) {
    case "pending":
      return (
        <Card className={`${CARD} shadow-none`}>
          <p className={`${P} text-muted-foreground`}>这篇文章的 AI 概览尚未生成。</p>
        </Card>
      );
    case "failed":
      return (
        <Card className={`${CARD} shadow-none`}>
          <p className={`${P} text-danger`}>概览生成失败{ai.error ? `：${ai.error}` : ""}。</p>
        </Card>
      );
    case "ready":
      return ai.overview ? (
        <OverviewBody overview={ai.overview} model={ai.model} />
      ) : (
        // `ready` without a body is a generator bug, not a state worth a design.
        <Card className={`${CARD} shadow-none`}>
          <p className={`${P} text-muted-foreground`}>这篇文章的 AI 概览尚未生成。</p>
        </Card>
      );
    default: {
      const never: never = ai.status;
      return never;
    }
  }
}

function OverviewBody({ overview, model }: { overview: Overview; model: string | null }) {
  const labels = sectionLabels(overview.genre);
  const { extras } = overview;
  const maturity = maturityClass(overview.maturity.status);
  return (
    <Card className={`${CARD} shadow-none`}>
      <div className="flex flex-wrap gap-1.5">
        {overview.genre && <span className="pill border-line-2 text-ink-2">{overview.genre}</span>}
        {maturity && (
          <span className={maturity} title={overview.maturity.evidence ?? undefined}>
            {overview.maturity.status}
          </span>
        )}
      </div>
      {overview.tldr && (
        <p className={`${P} text-[15px] leading-normal font-semibold text-ink`}>{overview.tldr}</p>
      )}
      {extras.thesis && (
        <p className={`${P} border-l-2 border-accent pl-2.5`}>
          <span className="label mb-0.5 block">主张</span>
          {extras.thesis}
        </p>
      )}
      {overview.summary && <p className={P}>{overview.summary}</p>}
      {overview.keyPoints.length > 0 && (
        <>
          <span className={LABEL}>{labels.keyPoints}</span>
          <ul className={UL}>
            {overview.keyPoints.map((point, index) => (
              <li key={index}>{point}</li>
            ))}
          </ul>
        </>
      )}
      {extras.arguments.length > 0 && (
        <>
          <span className={LABEL}>论点</span>
          <ul className={UL}>
            {extras.arguments.map((a, index) => (
              <li key={index}>
                {a.claim}
                {a.evidence && <span className={FINE}> — {a.evidence}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
      {overview.appliesWhen && (
        <>
          <span className={LABEL}>{labels.appliesWhen}</span>
          <p className={P}>{overview.appliesWhen}</p>
        </>
      )}
      {extras.compat.length > 0 && (
        <>
          <span className={LABEL}>环境</span>
          <ul className={UL}>
            {extras.compat.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {extras.quickStart.length > 0 && (
        <>
          <span className={LABEL}>上手</span>
          <ol className={OL}>
            {extras.quickStart.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ol>
        </>
      )}
      {extras.portingChecklist.length > 0 && (
        <>
          <span className={LABEL}>换到自己车上要改</span>
          <ul className={CHECKLIST}>
            {extras.portingChecklist.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {extras.lessons.length > 0 && (
        <>
          <span className={LABEL}>经验</span>
          <ul className="m-0 flex list-none flex-col gap-2 pl-0 text-ink-2">
            {extras.lessons.map((lesson, index) => (
              <li className="flex flex-col gap-0.5 text-[13px] leading-relaxed" key={index}>
                <div>
                  <span className="text-muted-foreground">{lesson.constraint}</span>
                  <span className="text-muted-foreground" aria-hidden="true">
                    {" → "}
                  </span>
                  {lesson.decision}
                </div>
                {lesson.outcome && <div className="text-muted-foreground">{lesson.outcome}</div>}
                {lesson.transferable && (
                  <div className="font-medium text-ink">{lesson.transferable}</div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {extras.actions.length > 0 && (
        <>
          <span className={LABEL}>可以直接做的</span>
          <ul className={CHECKLIST}>
            {extras.actions.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.package.length > 0 && labels.package && (
        <>
          <span className={LABEL}>{labels.package}</span>
          <ul className={UL}>
            {overview.package.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.caveats.length > 0 && (
        <>
          <span className={LABEL}>{labels.caveats}</span>
          <ul className={UL}>
            {overview.caveats.map((item, index) => (
              <li key={index}>{item}</li>
            ))}
          </ul>
        </>
      )}
      {overview.readingGuide && (
        <>
          <span className={LABEL}>阅读建议</span>
          <p className={P}>{overview.readingGuide}</p>
        </>
      )}
      {overview.faq.length > 0 && (
        <Disclosure
          className="border-t border-line pt-2.5"
          title={
            <>
              常见问题
              <span className="ml-1.5 font-mono text-[11px] font-normal text-muted-foreground">
                {overview.faq.length}
              </span>
            </>
          }
        >
          <dl className="mt-2.5 flex flex-col gap-2.5">
            {overview.faq.map((item, index) => (
              <div key={index}>
                <dt className="text-[13px] font-semibold text-ink">{item.question}</dt>
                <dd className="mt-0.5 text-[13px] leading-[1.65] text-ink-2">
                  {item.answer}
                  {item.source && (
                    <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">
                      {item.source}
                    </span>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        </Disclosure>
      )}
      {overview.maturity.evidence && (
        <p className={`${P} text-[13px] text-muted-foreground`}>
          <span className="label mr-1.5">依据</span>「{overview.maturity.evidence}」
        </p>
      )}
      <p className={`${P} ${FINE}`}>
        由 {model ?? "AI"} 根据正文、附件、仓库文档与参考文献生成，可能有误，请以原文为准。
      </p>
    </Card>
  );
}
