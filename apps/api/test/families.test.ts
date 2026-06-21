import { SignJWT } from "jose";
import { describe, expect, it } from "vitest";
import { HEALTH_API_PREFIX } from "@family-os/shared";
import { createApp } from "../src/app";
import { InMemoryFamilyRepository } from "../src/repositories/families";

const jwtSecret = "test-supabase-jwt-secret-with-enough-length";
const supabaseUrl = "https://project.supabase.co";
const userId = "00000000-0000-4000-8000-000000000101";
const otherUserId = "00000000-0000-4000-8000-000000000102";

function app() {
  return createApp({
    config: {
      NODE_ENV: "test",
      PORT: 3001,
      HEALTH_API_ENABLE_DEV_AUTH: false,
      SUPABASE_JWT_SECRET: jwtSecret,
      SUPABASE_URL: supabaseUrl
    },
    familyRepository: new InMemoryFamilyRepository()
  });
}

async function jwtFor(subject: string) {
  return new SignJWT({ role: "authenticated" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(subject)
    .setIssuer(`${supabaseUrl}/auth/v1`)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(new TextEncoder().encode(jwtSecret));
}

describe("family setup", () => {
  it("creates a family and makes the creator an active manager", async () => {
    const api = app();
    const token = await jwtFor(userId);

    const response = await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.data.family).toMatchObject({
      name: "Jain Family",
      createdByUserId: userId
    });
    expect(body.data.membership).toMatchObject({
      familyId: body.data.family.id,
      userId,
      role: "manager",
      status: "active"
    });
  });

  it("requires authentication to create a family", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    expect(response.status).toBe(401);
  });

  it("requires authentication to load the current family", async () => {
    const response = await app().request(`${HEALTH_API_PREFIX}/families/current`);

    expect(response.status).toBe(401);
  });

  it("returns the authenticated user's current family", async () => {
    const api = app();
    const token = await jwtFor(userId);
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: {
        authorization: `Bearer ${token}`
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: {
        family: {
          name: "Jain Family"
        },
        membership: {
          userId,
          role: "manager",
          status: "active"
        }
      }
    });
  });

  it("does not expose a family to a different authenticated user", async () => {
    const api = app();
    const managerToken = await jwtFor(userId);
    const otherToken = await jwtFor(otherUserId);
    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${managerToken}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({ name: "Jain Family" })
    });

    const response = await api.request(`${HEALTH_API_PREFIX}/families/current`, {
      headers: {
        authorization: `Bearer ${otherToken}`
      }
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ data: null });
  });

  it.each([
    [{}, "missing name"],
    [{ name: "" }, "empty name"],
    [{ name: "   " }, "whitespace-only name"],
    [{ name: 123 }, "non-string name"],
    [{ name: "a".repeat(121) }, "too-long name"]
  ])("validates family names: %s", async (payload, _label) => {
    const response = await app().request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${await jwtFor(userId)}`,
        "content-type": "application/json"
      },
      body: JSON.stringify(payload)
    });

    expect(response.status).toBe(400);
  });

  it("does not allow a user to create two active families", async () => {
    const api = app();
    const token = await jwtFor(userId);
    const headers = {
      authorization: `Bearer ${token}`,
      "content-type": "application/json"
    };

    await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Jain Family" })
    });
    const response = await api.request(`${HEALTH_API_PREFIX}/families`, {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "Second Family" })
    });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: "family_already_exists"
      }
    });
  });
});
