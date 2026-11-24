import { COMMANDS } from "@factory/dispatch-core/src/intent/index";
import { Page } from "../../lib/view";

export default function Help() {
  return (
    <Page title="Help">
      <p>The terminal (<code>dispatch</code>) and this dashboard show the same factory. Commands work in both; here they only navigate.</p>
      <table><caption className="sr">Commands</caption><thead><tr><th scope="col">Command</th><th scope="col">What it does</th></tr></thead><tbody>{COMMANDS.map((c) => (<tr key={c.name}><td><code>{c.usage}</code></td><td>{c.summary}</td></tr>))}</tbody></table>
    </Page>
  );
}
