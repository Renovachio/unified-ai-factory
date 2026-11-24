// Prints a redacted diagnostics bundle (counts, states, migration status, alerts). Usage: DATABASE_URL=... bun scripts/diagnostics.ts
import { connect, diagnosticsBundle } from "../packages/db/src/index";
const url = process.env.DATABASE_URL;
if (!url) { console.error("DATABASE_URL is required"); process.exit(2); }
const sql = connect(url);
try { console.log(JSON.stringify(await diagnosticsBundle(sql), null, 2)); } finally { await sql.end(); }
