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

export type FamilyRole = "manager" | "member";

export type MembershipStatus = "active" | "invited" | "removed";

export type Family = {
  id: string;
  name: string;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
};

export type FamilyMembership = {
  id: string;
  familyId: string;
  userId: string;
  role: FamilyRole;
  status: MembershipStatus;
  createdAt: string;
  updatedAt: string;
};

export type CurrentFamilyResponse = {
  family: Family;
  membership: FamilyMembership;
} | null;

export type FamilyInviteStatus = "pending" | "accepted" | "revoked" | "expired";

export type FamilyInvite = {
  id: string;
  familyId: string;
  email?: string;
  role: FamilyRole;
  status: FamilyInviteStatus;
  expiresAt: string;
  createdAt: string;
};

export type CreateInviteResponse = {
  invite: FamilyInvite;
  token: string;
};

export type PublicInviteResponse = {
  familyName: string;
  role: FamilyRole;
  status: FamilyInviteStatus;
  expiresAt: string;
};

export type PersonStatus = "active" | "inactive";

export type HealthProfile = {
  id: string;
  familyId: string;
  displayName: string;
  relationshipLabel?: string;
  dateOfBirth?: string;
  status: PersonStatus;
  createdAt: string;
  updatedAt: string;
};
