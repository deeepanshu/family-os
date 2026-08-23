import postgres from "postgres";
import { repositoriesFromFamilyRepository } from "../src/dependencies";
import { LOCAL_DEMO_USER_ID, seedLocalDemo } from "../src/localDemoSeed";
import { assertLocalSeedTarget, LocalDemoSeedError } from "../src/localDemoSeedGuard";
import { PostgresFamilyRepository } from "../src/repositories/postgres";
import { PostgresRepositoryContext } from "../src/repositories/postgres/context";

const databaseUrl = process.env.DATABASE_URL ?? "postgres://family_os:family_os@localhost:5432/family_os";
const userId = process.env.HEALTH_API_DEV_AUTH_USER_ID ?? LOCAL_DEMO_USER_ID;

try {
  assertLocalSeedTarget({ nodeEnv: process.env.NODE_ENV, databaseUrl });
} catch (error) {
  const message = error instanceof LocalDemoSeedError ? error.message : String(error);
  console.error(message);
  process.exit(1);
}

const sql = postgres(databaseUrl, { prepare: false, max: 10, connect_timeout: 10 });
const repository = new PostgresFamilyRepository(
  new PostgresRepositoryContext(sql, { syncLocalAuthUsers: true })
);
try {
  const result = await seedLocalDemo(repositoriesFromFamilyRepository(repository), { userId });
  console.log(`Seeded local demo for ${result.userId}`);
  console.log(`  profile: ${result.profileName} (${result.profileId})`);
  if (result.memberProfileId) {
    console.log(`  member: ${result.memberProfileName} (${result.memberProfileId})`);
  }
  console.log(`  family: ${result.familyName}`);
  console.log(`  window ending: ${result.asOf}`);
  console.log("Debug sign-in: Continue (dev-token). Switch profile to Jamie for member vitals.");
} finally {
  await sql.end({ timeout: 5 });
}
