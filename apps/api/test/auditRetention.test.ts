import { describe, expect, it } from "vitest";
import { InMemoryFamilyRepository } from "../src/repositories/families";

describe("audit log retention", () => {
  it("deletes rows older than 365 days and keeps newer ones", async () => {
    const repo = new InMemoryFamilyRepository();
    const now = new Date("2026-08-23T00:00:00.000Z");
    repo.insertAuditLogForTests({
      id: "old",
      familyId: null,
      action: "account.deleted",
      resourceType: "account",
      resourceId: "00000000-0000-4000-8000-000000000099",
      createdAt: "2025-08-22T00:00:00.000Z"
    });
    repo.insertAuditLogForTests({
      id: "fresh",
      familyId: null,
      action: "account.deleted",
      resourceType: "account",
      resourceId: "00000000-0000-4000-8000-000000000098",
      createdAt: "2026-08-01T00:00:00.000Z"
    });

    const removed = await repo.purgeExpiredAuditLogs(now);

    expect(removed).toBe(1);
    expect(repo.auditLogsForTests().map((entry) => entry.id)).toEqual(["fresh"]);
  });

  it("keeps a row exactly 365 days old", async () => {
    const repo = new InMemoryFamilyRepository();
    const now = new Date("2026-08-23T00:00:00.000Z");
    repo.insertAuditLogForTests({
      id: "boundary",
      familyId: null,
      action: "account.deleted",
      resourceType: "account",
      resourceId: "00000000-0000-4000-8000-000000000097",
      createdAt: "2025-08-23T00:00:00.000Z"
    });

    expect(await repo.purgeExpiredAuditLogs(now)).toBe(0);
    expect(repo.auditLogsForTests()).toHaveLength(1);
  });
});
