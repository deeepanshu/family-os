import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MCP_HEALTH_METRICS, type McpHealthMetric } from "@family-os/shared";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { McpCallerContext, HealthMcpReadService } from "./HealthMcpReadService";
import { encodeCappedJson, withTimeout } from "./responseCap";
import { toSafeToolErrorMessage } from "./toolErrors";

// Fixed product allowlist: steps, blood_pressure, blood_glucose, sleep, workout (plan §8.2).
const healthMetricSchema = z.enum([...MCP_HEALTH_METRICS] as [McpHealthMetric, ...McpHealthMetric[]]);

const getHealthDataInput = {
  personId: z.string().uuid().describe("Untrusted profile ID from list_authorized_profiles"),
  healthMetric: healthMetricSchema.describe(
    "One of steps, blood_pressure, blood_glucose, sleep, workout. Use sleep for night summaries (includes stages, optional wrist temperature and breathing disturbances). blood_glucose is mg/dL with optional mealTime preprandial|postprandial."
  ),
  rangeDays: z.number().int().min(1).max(90).describe("Number of local days to include, inclusive of today"),
  timezone: z.string().min(1).max(64).optional().describe("IANA timezone for local buckets. Defaults to UTC.")
};

export function createFamilyOsMcpServer(options: {
  service: HealthMcpReadService;
  caller: McpCallerContext;
  config: AppConfig;
}): McpServer {
  const { service, caller, config } = options;
  const server = new McpServer({
    name: "family-os-health-mcp",
    version: "0.1.0"
  });

  server.registerTool(
    "family_os.list_authorized_profiles",
    {
      title: "List authorized profiles",
      description:
        "Lists Family OS profiles the connected user may query. Returns familiar labels, untrusted person IDs, and the per-profile available health metrics (steps, blood_pressure, blood_glucose, sleep, workout) based on the user's enabled app toggles."
    },
    async () => {
      try {
        const result = await withTimeout(
          service.listAuthorizedProfiles(caller),
          config.MCP_TOOL_TIMEOUT_MS
        );
        return {
          content: [{ type: "text" as const, text: encodeCappedJson(result, config.MCP_MAX_RESULT_CHARS) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toSafeToolErrorMessage(error) }]
        };
      }
    }
  );

  server.registerTool(
    "family_os.get_health_data",
    {
      title: "Get health data",
      description:
        "Returns bounded, metric-specific health data for one authorized profile: blood pressure and blood glucose as reading tables (glucose in mg/dL with optional mealTime), sleep as a per-night summary (stages plus optional wrist temperature and breathing disturbance fields), and workouts as a bounded table. Strength workouts may include a user-authored exercises array (name, per-set reps, optional weightKg). Returns stored data with coverage and last-synced metadata, up to 90 days per call.",

      inputSchema: getHealthDataInput
    },
    async (args) => {
      try {
        const result = await withTimeout(
          service.getHealthData(caller, {
            personId: args.personId,
            healthMetric: args.healthMetric,
            rangeDays: args.rangeDays,
            timezone: args.timezone
          }),
          config.MCP_TOOL_TIMEOUT_MS
        );
        return {
          content: [{ type: "text" as const, text: encodeCappedJson(result, config.MCP_MAX_RESULT_CHARS) }]
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: toSafeToolErrorMessage(error) }]
        };
      }
    }
  );

  return server;
}
