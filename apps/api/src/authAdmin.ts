import type { AppConfig } from "./config";
import { HttpError } from "./errors";

/**
 * Hard-delete a Supabase Auth user via the Admin API.
 * No-ops when service role is not configured (memory tests / local without Auth).
 * Treats 404 as success so DELETE /me stays idempotent.
 */
export async function deleteSupabaseAuthUser(config: AppConfig, userId: string): Promise<void> {
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    return;
  }

  const base = config.SUPABASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/auth/v1/admin/users/${userId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
      apikey: config.SUPABASE_SERVICE_ROLE_KEY
    }
  });

  if (response.ok || response.status === 404) {
    return;
  }

  throw new HttpError(500, "auth_delete_failed", "Could not delete the authentication identity.");
}
