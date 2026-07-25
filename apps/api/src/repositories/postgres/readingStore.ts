import type { BloodPressureReading } from "@family-os/shared";
import { HttpError } from "../../errors";
import { PostgresRepositoryContext } from "./context";
import { mapBloodPressure } from "./mappers";

export class PostgresReadingStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async listBloodPressure(actorUserId: string, personId?: string, limit = 50): Promise<BloodPressureReading[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = personId
      ? await this.context.sql`
          select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
          from health_blood_pressure_readings r
          join healthkit_sync_profile_settings s on s.person_id = r.person_id
          where r.family_id = ${current.family.id}
            and r.person_id = ${personId}
          order by r.measured_at desc
          limit ${limit}
        `
      : await this.context.sql`
          select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
          from health_blood_pressure_readings r
          join healthkit_sync_profile_settings s on s.person_id = r.person_id
          where r.family_id = ${current.family.id}
          order by r.measured_at desc
          limit ${limit}
        `;
    return rows.map(mapBloodPressure);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [reading] = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_pressure_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.id = ${readingId}
        and r.family_id = ${current.family.id}
    `;
    if (!reading) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    return mapBloodPressure(reading);
  }
}
