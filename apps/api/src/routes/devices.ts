import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { z } from "zod";
import { requireAuth, type AppVariables } from "../auth";
import type { DeviceStore } from "../repositories/contracts";

const body = z.object({ deviceToken: z.string().trim().min(16).max(4096), platform: z.literal("ios") });
const idParam = z.object({ id: z.string().uuid() });

export function createDeviceRoutes(repository: DeviceStore) {
  const devices = new Hono<{ Variables: AppVariables }>();
  devices.use("*", requireAuth());
  devices.post("/", zValidator("json", body), async (c) => {
    const data = await repository.registerDevice({ userId: c.get("user").id, deviceToken: c.req.valid("json").deviceToken });
    return c.json({ data }, 201);
  });
  devices.delete("/:id", zValidator("param", idParam), async (c) => {
    await repository.deleteDevice(c.get("user").id, c.req.valid("param").id);
    return c.body(null, 204);
  });
  return devices;
}
