import { HEALTH_API_PREFIX } from "@family-os/shared";

type Api = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};

/** Solo-first: bootstrap + Self profile (no family). */
export async function setupSoloUser(
  api: Api,
  token: string,
  displayName = "Deepanshu"
): Promise<{ profileId: string }> {
  await api.request(`${HEALTH_API_PREFIX}/bootstrap`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` }
  });
  const profile = await (
    await api.request(`${HEALTH_API_PREFIX}/me/profile`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ displayName })
    })
  ).json();
  return { profileId: profile.data.id as string };
}

/** Optional household after solo Self exists. */
export async function setupHousehold(
  api: Api,
  token: string,
  name = "Test Family"
): Promise<void> {
  const res = await api.request(`${HEALTH_API_PREFIX}/families`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name })
  });
  if (!res.ok) {
    throw new Error(`create family failed: ${res.status} ${await res.text()}`);
  }
}
