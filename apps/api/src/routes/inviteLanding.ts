import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import type { InviteStore } from "../repositories/contracts";
import { HttpError } from "../errors";

const tokenSchema = z.object({
  token: z.string().min(16).max(256)
});

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderInviteLandingPage(input: {
  familyName: string;
  creatorDisplayName: string;
  token: string;
  status: string;
}): string {
  const openUrl = `familyos://invite/${input.token}`;
  const title = input.status === "pending" ? "You're invited to FamilyStack" : "This invite is no longer open";
  const body =
    input.status === "pending"
      ? `${input.creatorDisplayName} invited you to ${input.familyName}. Open FamilyStack to join.`
      : "This invite has expired or already been used.";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
</head>
<body>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(body)}</p>
  <p><a href="${escapeHtml(openUrl)}">Open in FamilyStack</a></p>
</body>
</html>`;
}

export function createInviteLandingRoutes(repository: InviteStore) {
  const landing = new Hono();

  landing.get("/:token", zValidator("param", tokenSchema), async (c) => {
    const { token } = c.req.valid("param");
    try {
      const preview = await repository.getInviteByToken(token);
      c.header("content-type", "text/html; charset=utf-8");
      return c.body(
        renderInviteLandingPage({
          familyName: preview.familyName,
          creatorDisplayName: preview.creatorDisplayName,
          token,
          status: preview.status
        })
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404) {
        c.header("content-type", "text/html; charset=utf-8");
        return c.body(
          renderInviteLandingPage({
            familyName: "FamilyStack",
            creatorDisplayName: "Someone",
            token,
            status: "unknown"
          }),
          404
        );
      }
      throw error;
    }
  });

  return landing;
}
