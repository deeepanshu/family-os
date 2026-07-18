import type { McpCapability, McpConnectionGrant } from "@family-os/shared";
import { HttpError } from "../../errors";
import type { CreateMcpConnectionInput } from "../contracts";
import { PostgresRepositoryContext } from "./context";
import { toIso, toOptionalIso } from "./dateUtils";
import type { Row } from "./types";

export class PostgresMcpConnectionStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async createConnection(input: CreateMcpConnectionInput): Promise<McpConnectionGrant> {
    const capabilities = normalizeMcpCapabilities(input.capabilities);
    await this.context.syncAuthUser(input.userId);

    await this.context.sql`
      update mcp_connection_grants
      set revoked_at = now(), updated_at = now()
      where user_id = ${input.userId}
        and oauth_client_id = ${input.oauthClientId}
        and revoked_at is null
    `;

    const [row] = await this.context.sql`
      insert into mcp_connection_grants (
        user_id,
        oauth_client_id,
        capabilities,
        consent_version,
        expires_at
      ) values (
        ${input.userId},
        ${input.oauthClientId},
        ${capabilities},
        ${input.consentVersion},
        ${input.expiresAt ?? null}
      )
      returning *
    `;
    return mapMcpConnection(row);
  }

  async getActiveConnection(userId: string, oauthClientId: string): Promise<McpConnectionGrant | null> {
    const [row] = await this.context.sql`
      select *
      from mcp_connection_grants
      where user_id = ${userId}
        and oauth_client_id = ${oauthClientId}
        and revoked_at is null
        and (expires_at is null or expires_at > now())
      order by created_at desc
      limit 1
    `;
    return row ? mapMcpConnection(row) : null;
  }

  async revokeConnection(userId: string, connectionId: string): Promise<McpConnectionGrant> {
    const [existing] = await this.context.sql`
      select *
      from mcp_connection_grants
      where id = ${connectionId}
        and user_id = ${userId}
    `;
    if (!existing) {
      throw new HttpError(404, "mcp_connection_not_found", "MCP connection grant was not found.");
    }
    if (existing.revoked_at) {
      return mapMcpConnection(existing);
    }
    const [row] = await this.context.sql`
      update mcp_connection_grants
      set revoked_at = now(), updated_at = now()
      where id = ${connectionId}
        and user_id = ${userId}
      returning *
    `;
    return mapMcpConnection(row);
  }

  async listConnections(userId: string): Promise<McpConnectionGrant[]> {
    const rows = await this.context.sql`
      select *
      from mcp_connection_grants
      where user_id = ${userId}
      order by created_at desc
    `;
    return rows.map(mapMcpConnection);
  }
}

function mapMcpConnection(row: Row): McpConnectionGrant {
  return {
    id: row.id,
    userId: row.user_id,
    oauthClientId: row.oauth_client_id,
    capabilities: row.capabilities as McpCapability[],
    consentVersion: row.consent_version,
    createdAt: toIso(row.created_at),
    expiresAt: toOptionalIso(row.expires_at),
    revokedAt: toOptionalIso(row.revoked_at)
  };
}

function normalizeMcpCapabilities(capabilities: McpCapability[]): McpCapability[] {
  const allowed = new Set<McpCapability>(["health_read"]);
  const unique = [...new Set(capabilities)].filter((cap): cap is McpCapability => allowed.has(cap));
  if (unique.length === 0) {
    throw new HttpError(400, "mcp_capabilities_required", "At least one MCP capability is required.");
  }
  return unique;
}
