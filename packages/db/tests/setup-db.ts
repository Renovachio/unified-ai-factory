// Bun test preload: provide a Postgres for integration tests.
// CI: set DATABASE_URL to a service container. Local: a throwaway cluster is started and stopped automatically.
import { startTempCluster } from "../src/testing";

if (!process.env.TEST_DATABASE_URL) {
  if (process.env.DATABASE_URL) {
    process.env.TEST_DATABASE_URL = process.env.DATABASE_URL;
  } else {
    const c = startTempCluster();
    process.env.TEST_DATABASE_URL = c.url;
    process.on("exit", c.stop);
    for (const sig of ["SIGINT", "SIGTERM"] as const)
      process.on(sig, () => {
        c.stop();
        process.exit(1);
      });
  }
}
