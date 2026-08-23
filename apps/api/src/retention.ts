import { logError } from "./logging/otelLogs";
import type { AuditLogStore } from "./repositories/contracts";

export const AUDIT_LOG_RETENTION_DAYS = 365;
export const CRASHLYTICS_RETENTION_DAYS = 90;
export const OPERATIONAL_LOG_RETENTION_DAYS = 30;
export const APPLICATION_BACKUP_RETENTION_DAYS = 0;

export const AUDIT_LOG_RETENTION_MS = AUDIT_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;

const PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function auditLogCutoff(now = new Date()): Date {
  return new Date(now.getTime() - AUDIT_LOG_RETENTION_MS);
}

export function startAuditLogRetention(store: AuditLogStore, nodeEnv: string): void {
  if (nodeEnv === "test") {
    return;
  }
  const run = () => {
    void store.purgeExpiredAuditLogs().catch((error) => {
      logError("audit_log_purge_failed", {
        error: error instanceof Error ? error.message : String(error)
      });
    });
  };
  run();
  const timer = setInterval(run, PURGE_INTERVAL_MS);
  if (typeof timer === "object" && timer && "unref" in timer) {
    timer.unref();
  }
}
