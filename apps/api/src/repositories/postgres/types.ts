import type { Sql } from "postgres";

export type PgExecutor = Sql | any;

export type PostgresRepositoryOptions = {
  syncLocalAuthUsers?: boolean;
};

export type Row = Record<string, any>;

export function requireRow<T extends Row>(row: T | undefined, message: string): T {
  if (!row) {
    throw new Error(message);
  }
  return row;
}

