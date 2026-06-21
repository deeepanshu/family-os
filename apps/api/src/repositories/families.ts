import type { CurrentFamilyResponse, Family, FamilyMembership } from "@family-os/shared";
import { HttpError } from "../errors";

export type CreateFamilyInput = {
  name: string;
  userId: string;
};

export interface FamilyRepository {
  createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse>;
  getCurrentFamily(userId: string): Promise<CurrentFamilyResponse>;
}

export class InMemoryFamilyRepository implements FamilyRepository {
  private readonly families = new Map<string, Family>();
  private readonly memberships = new Map<string, FamilyMembership>();

  async createFamily(input: CreateFamilyInput): Promise<CurrentFamilyResponse> {
    const existing = await this.getCurrentFamily(input.userId);
    if (existing) {
      throw new HttpError(409, "family_already_exists", "User already has an active family.");
    }

    const now = new Date().toISOString();
    const family: Family = {
      id: crypto.randomUUID(),
      name: input.name,
      createdByUserId: input.userId,
      createdAt: now,
      updatedAt: now
    };
    const membership: FamilyMembership = {
      id: crypto.randomUUID(),
      familyId: family.id,
      userId: input.userId,
      role: "manager",
      status: "active",
      createdAt: now,
      updatedAt: now
    };

    this.families.set(family.id, family);
    this.memberships.set(membership.id, membership);

    return { family, membership };
  }

  async getCurrentFamily(userId: string): Promise<CurrentFamilyResponse> {
    const membership = [...this.memberships.values()].find(
      (candidate) => candidate.userId === userId && candidate.status === "active"
    );
    if (!membership) {
      return null;
    }

    const family = this.families.get(membership.familyId);
    if (!family) {
      return null;
    }

    return { family, membership };
  }
}
