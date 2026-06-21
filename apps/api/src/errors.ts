import type { Context } from "hono";

export class HttpError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 404 | 409 | 422 | 500,
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export function jsonError(c: Context, error: HttpError) {
  return c.json(
    {
      error: {
        code: error.code,
        message: error.message
      }
    },
    error.status
  );
}
