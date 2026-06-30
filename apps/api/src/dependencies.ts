import type { AppConfig } from "./config";
import { InMemoryFamilyRepository, type FamilyRepository } from "./repositories/families";
import { PostgresFamilyRepository } from "./repositories/postgres";
import type { AppRepositories } from "./repositories/contracts";

export type AppDependencies = {
  familyRepository: FamilyRepository;
  repositories: AppRepositories;
};

export function createDependencies(config: AppConfig): AppDependencies {
  if (config.HEALTH_API_REPOSITORY === "memory") {
    const familyRepository = new InMemoryFamilyRepository();
    return {
      familyRepository,
      repositories: repositoriesFromFamilyRepository(familyRepository)
    };
  }

  const familyRepository = PostgresFamilyRepository.fromDatabaseUrl(config.DATABASE_URL!, {
    syncLocalAuthUsers: config.HEALTH_API_SYNC_LOCAL_AUTH_USERS
  });
  return {
    familyRepository,
    repositories: repositoriesFromFamilyRepository(familyRepository)
  };
}

export function repositoriesFromFamilyRepository(familyRepository: FamilyRepository): AppRepositories {
  return {
    families: familyRepository,
    invites: familyRepository,
    profiles: familyRepository,
    readings: familyRepository,
    healthKit: familyRepository,
    reminders: familyRepository,
    devices: familyRepository,
    notificationDeliveries: familyRepository,
    auditLogs: familyRepository
  };
}
