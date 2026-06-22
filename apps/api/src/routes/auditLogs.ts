import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyRepository } from "../repositories/families";

const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(100)
});

export function createAuditLogRoutes(repository: FamilyRepository) {
  const auditLogs = new Hono<{ Variables: AppVariables }>();
  auditLogs.use("*", requireAuth());

  auditLogs.get("/", zValidator("query", query), async (c) => {
    const parsed = c.req.valid("query");
    const data = await repository.listAuditLogs(c.get("user").id, parsed.limit);
    return c.json({ data });
  });

  return auditLogs;
}
