import { adapterContractSuite } from "../src/testing/contract-suite";
import { MockAdapter } from "../src/mock";

adapterContractSuite({
  name: "MockAdapter",
  expectedAuthMode: "local_model",
  create: (behavior) => new MockAdapter({ behavior }),
  createWithForbiddenEnv: () => new MockAdapter({ env: { ANTHROPIC_API_KEY: "sk-ant-x" } }),
});
