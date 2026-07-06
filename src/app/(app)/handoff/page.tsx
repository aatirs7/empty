import { HANDOFF, HANDOFF_UPDATED } from "@/lib/handoff";
import { PageTitle } from "@/components/ui";
import CopyButton from "@/components/CopyButton";

export const dynamic = "force-dynamic";

export default function HandoffPage() {
  return (
    <div className="space-y-4">
      <PageTitle title="Handoff" subtitle={`context doc, updated ${HANDOFF_UPDATED}`} />
      <p className="text-xs text-muted text-center leading-relaxed">
        Paste this into any chat to bring it fully up to speed on Vega&apos;s architecture, features, and current state.
      </p>
      <CopyButton text={HANDOFF} />
      <pre className="bg-panel border border-border rounded-2xl p-4 text-[11px] leading-relaxed whitespace-pre-wrap overflow-x-auto">
        {HANDOFF}
      </pre>
    </div>
  );
}
