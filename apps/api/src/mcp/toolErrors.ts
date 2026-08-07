import { HttpError } from "../errors";

export function toSafeToolErrorMessage(error: unknown): string {
  if (error instanceof HttpError) {
    switch (error.code) {
      case "mcp_connection_required":
        return "An active Family OS MCP connection is required. Connect Family OS in the client and try again.";
      case "mcp_capability_denied":
        return "This connection is not allowed to read health data.";
      case "profile_not_found":
      case "profile_forbidden":
        return "The requested profile was not found or is not authorized for this user.";
      case "unsupported_metric":
      case "invalid_range_days":
      case "range_days_exceeded":
      case "granularity_not_supported":
      case "invalid_granularity":
      case "invalid_timezone":
      case "group_disabled":
        return error.message;
      case "rate_limited":
        return "Too many MCP requests. Try again later.";
      default:
        return "The request could not be completed.";
    }
  }
  if (error instanceof Error && error.message === "tool_timeout") {
    return "The health data request timed out. Try a smaller range.";
  }
  if (error instanceof Error && error.message === "result_too_large") {
    return "The result exceeded the maximum allowed size. Request a smaller range.";
  }
  return "The request could not be completed.";
}
