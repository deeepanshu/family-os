import type { AppConfig } from "./config";
import { InMemoryFamilyRepository, type FamilyRepository } from "./repositories/families";
import { PostgresFamilyRepository } from "./repositories/postgres";

export type AppDependencies = {
  familyRepository: FamilyRepository;
};

export function createDependencies(config: AppConfig): AppDependencies {
  if (config.HEALTH_API_REPOSITORY === "memory") {
    return {
      familyRepository: new InMemoryFamilyRepository()
    };
  }

  return {
    familyRepository: PostgresFamilyRepository.fromDatabaseUrl(config.DATABASE_URL!, {
      syncLocalAuthUsers: config.HEALTH_API_SYNC_LOCAL_AUTH_USERS
    })
  };
}
