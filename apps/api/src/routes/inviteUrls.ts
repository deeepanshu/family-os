import type { BootstrapResponse, CurrentFamilyResponse } from "@family-os/shared";

export function inviteShareUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/invite/${token}`;
}

export function attachLiveInviteUrl<T extends { liveInvite?: { token: string; url?: string } }>(
  data: T,
  origin: string
): T {
  if (!data.liveInvite) {
    return data;
  }
  return {
    ...data,
    liveInvite: {
      ...data.liveInvite,
      url: inviteShareUrl(origin, data.liveInvite.token)
    }
  };
}

export function attachHouseholdUrls(
  data: CurrentFamilyResponse,
  origin: string
): CurrentFamilyResponse {
  if (!data) {
    return data;
  }
  return attachLiveInviteUrl(data, origin);
}

export function attachBootstrapUrls(data: BootstrapResponse, origin: string): BootstrapResponse {
  return attachLiveInviteUrl(data, origin);
}
