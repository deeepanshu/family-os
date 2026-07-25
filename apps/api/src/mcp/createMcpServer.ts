import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { HEALTHKIT_METRIC_KEYS } from "@family-os/shared";
import { z } from "zod";
import type { AppConfig } from "../config";
import type { McpCallerContext, HealthMcpReadService } from "./HealthMcpReadService";
import { encodeCappedJson, withTimeout } from "./responseCap";
import { toSafeToolErrorMessage } from "./toolErrors";

const healthMetricSchema = z.enum(HEALTHKIT_METRIC_KEYS);
const granularitySchema = z.enum(["hourly", "daily"]);

const getHealthDataInput = {
  personId: z.string().uuid().describe("Untrusted profile ID from list_authorized_profiles"),
  healthMetric: healthMetricSchema.describe("Allowlisted Family OS HealthKit metric"),
  rangeDays: z.number().int().min(1).max(90).describe("Number of local days to include, inclusive of today"),
  granularity: granularitySchema
    .optional()
    .describe("Steps only. hourly max 7 days; daily max 90 days. Defaults to daily."),
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
        "Lists Family OS profiles the connected user may query. Returns familiar labels and untrusted person IDs plus available metric categories. Data is informational only and not medical advice. Coverage depends on what has been synced into Family OS."
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
        "Returns bounded, metric-specific health data for one authorized profile. Steps support hourly or daily series; daily metrics include aggregate statistics; sleep includes stages; blood pressure, glucose, and workouts return bounded tables. Always includes coverage and freshness. Informational only, not medical advice, diagnosis, or treatment guidance.",
      inputSchema: getHealthDataInput
    },
    async (args) => {
      try {
        const result = await withTimeout(
          service.getHealthData(caller, {
            personId: args.personId,
            healthMetric: args.healthMetric,
            rangeDays: args.rangeDays,
            granularity: args.granularity,
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
