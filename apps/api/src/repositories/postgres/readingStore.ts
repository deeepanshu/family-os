import type { BloodGlucoseReading, BloodPressureReading } from "@family-os/shared";
import { HttpError } from "../../errors";
import type {
  CreateBloodGlucoseInput,
  CreateBloodPressureInput,
  UpdateBloodGlucoseInput,
  UpdateBloodPressureInput
} from "../families";
import { PostgresRepositoryContext } from "./context";
import { mapBloodGlucose, mapBloodPressure } from "./mappers";
import { requireRow } from "./types";

export class PostgresReadingStore {
  constructor(private readonly context: PostgresRepositoryContext) {}

  async createBloodPressure(input: CreateBloodPressureInput): Promise<BloodPressureReading> {
    const current = await this.context.requireActiveMember(input.actorUserId);
    await this.context.requireProfileInFamily(input.personId, current.family.id);
    const [reading] = await this.context.sql`
      insert into blood_pressure_readings
        (family_id, person_id, recorded_by_user_id, systolic, diastolic, pulse, measured_at, context, notes)
      values (
        ${current.family.id},
        ${input.personId},
        ${input.actorUserId},
        ${input.systolic},
        ${input.diastolic},
        ${input.pulse ?? null},
        ${input.measuredAt},
        ${input.context ?? null},
        ${input.notes ?? null}
      )
      returning *
    `;
    const createdReading = requireRow(reading, "Failed to create blood pressure reading.");
    await this.context.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "blood_pressure.created",
      resourceType: "blood_pressure_reading",
      resourceId: createdReading.id,
      metadata: { personId: input.personId }
    });
    return mapBloodPressure(createdReading);
  }

  async listBloodPressure(actorUserId: string, personId?: string, limit = 50): Promise<BloodPressureReading[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = personId
      ? await this.context.sql`
          select *
          from blood_pressure_readings
          where family_id = ${current.family.id}
            and person_id = ${personId}
            and deleted_at is null
          order by measured_at desc
          limit ${limit}
        `
      : await this.context.sql`
          select *
          from blood_pressure_readings
          where family_id = ${current.family.id}
            and deleted_at is null
          order by measured_at desc
          limit ${limit}
        `;
    return rows.map(mapBloodPressure);
  }

  async getBloodPressure(actorUserId: string, readingId: string): Promise<BloodPressureReading> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [reading] = await this.context.sql`
      select *
      from blood_pressure_readings
      where id = ${readingId}
        and family_id = ${current.family.id}
        and deleted_at is null
    `;
    if (!reading) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    return mapBloodPressure(reading);
  }

  async updateBloodPressure(
    actorUserId: string,
    readingId: string,
    input: UpdateBloodPressureInput
  ): Promise<BloodPressureReading> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getBloodPressure(actorUserId, readingId);
    if (existing.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can change this reading.");
    }
    const [reading] = await this.context.sql`
      update blood_pressure_readings
      set
        systolic = coalesce(${input.systolic ?? null}, systolic),
        diastolic = coalesce(${input.diastolic ?? null}, diastolic),
        pulse = coalesce(${input.pulse ?? null}, pulse),
        measured_at = coalesce(${input.measuredAt ?? null}, measured_at),
        context = coalesce(${input.context ?? null}, context),
        notes = coalesce(${input.notes ?? null}, notes)
      where id = ${readingId}
      returning *
    `;
    if (!reading) {
      throw new HttpError(404, "bp_reading_not_found", "Blood pressure reading was not found.");
    }
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_pressure.updated",
      resourceType: "blood_pressure_reading",
      resourceId: readingId
    });
    return mapBloodPressure(reading);
  }

  async deleteBloodPressure(actorUserId: string, readingId: string): Promise<void> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getBloodPressure(actorUserId, readingId);
    if (existing.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can delete this reading.");
    }
    await this.context.sql`update blood_pressure_readings set deleted_at = now() where id = ${readingId}`;
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_pressure.deleted",
      resourceType: "blood_pressure_reading",
      resourceId: readingId
    });
  }

  async createBloodGlucose(input: CreateBloodGlucoseInput): Promise<BloodGlucoseReading> {
    const current = await this.context.requireActiveMember(input.actorUserId);
    await this.context.requireProfileInFamily(input.personId, current.family.id);
    const [reading] = await this.context.sql`
      insert into blood_glucose_readings
        (family_id, person_id, recorded_by_user_id, value, unit, context, measured_at, notes)
      values (
        ${current.family.id},
        ${input.personId},
        ${input.actorUserId},
        ${input.value},
        'mg/dL',
        ${input.context},
        ${input.measuredAt},
        ${input.notes ?? null}
      )
      returning *
    `;
    const createdReading = requireRow(reading, "Failed to create blood sugar reading.");
    await this.context.audit({
      familyId: current.family.id,
      actorUserId: input.actorUserId,
      action: "blood_glucose.created",
      resourceType: "blood_glucose_reading",
      resourceId: createdReading.id,
      metadata: { personId: input.personId }
    });
    return mapBloodGlucose(createdReading);
  }

  async listBloodGlucose(actorUserId: string, personId?: string, limit = 50): Promise<BloodGlucoseReading[]> {
    const current = await this.context.requireActiveMember(actorUserId);
    const rows = personId
      ? await this.context.sql`
          select *
          from blood_glucose_readings
          where family_id = ${current.family.id}
            and person_id = ${personId}
            and deleted_at is null
          order by measured_at desc
          limit ${limit}
        `
      : await this.context.sql`
          select *
          from blood_glucose_readings
          where family_id = ${current.family.id}
            and deleted_at is null
          order by measured_at desc
          limit ${limit}
        `;
    return rows.map(mapBloodGlucose);
  }

  async getBloodGlucose(actorUserId: string, readingId: string): Promise<BloodGlucoseReading> {
    const current = await this.context.requireActiveMember(actorUserId);
    const [reading] = await this.context.sql`
      select *
      from blood_glucose_readings
      where id = ${readingId}
        and family_id = ${current.family.id}
        and deleted_at is null
    `;
    if (!reading) {
      throw new HttpError(404, "glucose_reading_not_found", "Blood sugar reading was not found.");
    }
    return mapBloodGlucose(reading);
  }

  async updateBloodGlucose(
    actorUserId: string,
    readingId: string,
    input: UpdateBloodGlucoseInput
  ): Promise<BloodGlucoseReading> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getBloodGlucose(actorUserId, readingId);
    if (existing.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can change this reading.");
    }
    const [reading] = await this.context.sql`
      update blood_glucose_readings
      set
        value = coalesce(${input.value ?? null}, value),
        context = coalesce(${input.context ?? null}, context),
        measured_at = coalesce(${input.measuredAt ?? null}, measured_at),
        notes = coalesce(${input.notes ?? null}, notes)
      where id = ${readingId}
      returning *
    `;
    if (!reading) {
      throw new HttpError(404, "glucose_reading_not_found", "Blood sugar reading was not found.");
    }
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_glucose.updated",
      resourceType: "blood_glucose_reading",
      resourceId: readingId
    });
    return mapBloodGlucose(reading);
  }

  async deleteBloodGlucose(actorUserId: string, readingId: string): Promise<void> {
    const current = await this.context.requireActiveMember(actorUserId);
    const existing = await this.getBloodGlucose(actorUserId, readingId);
    if (existing.recordedByUserId !== actorUserId && current.membership.role !== "manager") {
      throw new HttpError(403, "reading_owner_or_manager_required", "Only the recorder or a manager can delete this reading.");
    }
    await this.context.sql`update blood_glucose_readings set deleted_at = now() where id = ${readingId}`;
    await this.context.audit({
      familyId: current.family.id,
      actorUserId,
      action: "blood_glucose.deleted",
      resourceType: "blood_glucose_reading",
      resourceId: readingId
    });
  }
}

