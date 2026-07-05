import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { FamilyStore } from "../repositories/contracts";

const createFamilySchema = z.object({
  name: z.string().trim().min(1).max(120)
});

export function createFamilyRoutes(repository: FamilyStore) {
  const families = new Hono<{ Variables: AppVariables }>();

  families.use("*", requireAuth());

  families.post("/", zValidator("json", createFamilySchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");
    const data = await repository.createFamily({
      name: body.name,
      userId: user.id
    });

    return c.json({ data }, 201);
  });

  families.get("/current", async (c) => {
    const user = c.get("user");
    const data = await repository.getCurrentFamily(user.id);
    return c.json({ data });
  });

  families.get("/members", async (c) => {
    const user = c.get("user");
    const data = await repository.listMembers(user.id);
    return c.json({ data });
  });

  return families;
}
