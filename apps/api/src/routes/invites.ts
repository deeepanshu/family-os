import { CREATOR_RELATIONSHIP_LABELS } from "@family-os/shared";
import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { AppConfig } from "../config";
import { mcpPublicOrigin } from "../mcp/publicUrl";
import type { InviteStore } from "../repositories/contracts";
import { inviteShareUrl } from "./inviteUrls";

const createInviteSchema = z.object({}).strict();

const tokenSchema = z.object({
  token: z.string().min(16).max(256)
});

const acceptInviteSchema = z.object({
  relationshipLabel: z.enum(CREATOR_RELATIONSHIP_LABELS)
});

export function createInviteRoutes(repository: InviteStore, config: AppConfig) {
  const invites = new Hono<{ Variables: AppVariables }>();

  invites.post("/", requireAuth(), zValidator("json", createInviteSchema), async (c) => {
    const user = c.get("user");
    const created = await repository.createInvite({
      actorUserId: user.id
    });
    const data = {
      ...created,
      url: inviteShareUrl(mcpPublicOrigin(config), created.token)
    };
    return c.json({ data }, 201);
  });

  invites.get("/:token", zValidator("param", tokenSchema), async (c) => {
    const { token } = c.req.valid("param");
    const data = await repository.getInviteByToken(token);
    return c.json({ data });
  });

  invites.post(
    "/:token/accept",
    requireAuth(),
    zValidator("param", tokenSchema),
    zValidator("json", acceptInviteSchema),
    async (c) => {
      const user = c.get("user");
      const { token } = c.req.valid("param");
      const { relationshipLabel } = c.req.valid("json");
      const data = await repository.acceptInvite(token, user.id, { relationshipLabel });
      return c.json({ data });
    }
  );

  return invites;
}
