import type { BloodPressureReading } from "@family-os/shared";
import { HttpError } from "../../errors";
import { PostgresRepositoryContext } from "./context";
import { mapBloodPressure } from "./mappers";

export class PostgresReadingStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async listBloodPressure(actorUserId: string, personId?: string, limit = 50): Promise<BloodPressureReading[]> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const targetPersonId = personId ?? self.personId;
    await this.context.requirePersonAccess(actorUserId, targetPersonId);
    const rows = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_pressure_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.person_id = ${targetPersonId}
      order by r.measured_at desc
      limit ${limit}
    `;
    return rows.map(mapBloodPressure);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const self = await this.context.requireSelfPerson(actorUserId);
    const [reading] = await this.context.sql`
      select r.*, s.user_id as recorded_by_user_id, 'healthkit'::text as source
      from health_blood_pressure_readings r
      join healthkit_sync_profile_settings s on s.person_id = r.person_id
      where r.id = ${readingId}
    `;
    if (!reading) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    await this.context.requirePersonAccess(actorUserId, reading.person_id as string);
    return mapBloodPressure(reading);
  }
}
