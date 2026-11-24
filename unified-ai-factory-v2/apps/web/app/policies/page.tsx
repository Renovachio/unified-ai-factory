import { Page } from "../../lib/view";

export const dynamic = "force-dynamic";

/** Policy lives in the factory control repository and is not editable here (agents and target repos cannot change it either). */
export default function Policies() {
  return (
    <Page title="Policies">
      <p>Risk, merge and model-source policies are owned by the factory control configuration (<code>config/risk-policy.json</code>, <code>config/gates/</code>, <code>config/inference-policy.json</code>) and are changed only by an operator through review. Each job&apos;s page shows the policy that applied to it, bound by digest to every approval.</p>
      <ul>
        <li>Inference sources: subscription CLI (only with a recorded provider-terms approval) or local models. No API keys or metered endpoints.</li>
        <li>Pilot: every merge requires a human approval of the exact candidate; HIGH and CRITICAL always do.</li>
      </ul>
    </Page>
  );
}
