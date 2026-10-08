import type { HumanIntervention } from "./humanIntervention";

/**
 * Tags the human messages that the gate recorded as interventions. The transcript is upstream
 * markup, so the tag is a scoped ::before rule keyed on the message id the event carries
 * (data-message-id / data-message-role are the transcript's own row attributes). It follows
 * the row through re-renders and scrolling, and needs no DOM mutation. Look matches Badge
 * `warning`, small.
 */
export function InterventionMarks({
  paneId,
  interventions,
}: {
  paneId: string;
  interventions: ReadonlyArray<HumanIntervention>;
}) {
  if (interventions.length === 0) return null;
  const rules = interventions
    .map(
      (event) =>
        `[data-a2a-pane=${JSON.stringify(paneId)}] [data-message-id=${JSON.stringify(event.messageId)}][data-message-role="user"]::before`,
    )
    .join(",");
  return (
    <style>{`${rules}{content:"人工介入";display:block;width:fit-content;margin:0 0 0.25rem auto;padding:0 0.375rem;border-radius:0.25rem;font-size:var(--text-ui-2xs);font-weight:500;line-height:1rem;color:var(--color-warning);background:color-mix(in srgb,var(--color-warning) 12%,transparent)}`}</style>
  );
}
