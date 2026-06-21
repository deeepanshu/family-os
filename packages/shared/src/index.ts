export const HEALTH_API_PREFIX = "/health/v1" as const;

export type ApiEnvelope<T> = {
  data: T;
};

export type ApiErrorEnvelope = {
  error: {
    code: string;
    message: string;
  };
};

export type HealthcheckResponse = {
  service: "family-os-health-api";
  status: "ok";
};

export type AuthSessionResponse = {
  userId: string;
};
