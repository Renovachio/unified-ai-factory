import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export type Sql = ReturnType<typeof postgres>;

export function connect(url: string, opts: { max?: number } = {}): Sql {
  return postgres(url, { max: opts.max ?? 10, onnotice: () => undefined });
}

export function orm(sql: Sql) {
  return drizzle(sql, { schema });
}
export type Db = ReturnType<typeof orm>;
