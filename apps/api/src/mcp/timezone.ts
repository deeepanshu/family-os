export function resolveTimezone(timezone?: string): string {
  if (!timezone || timezone.trim() === "") {
    return "UTC";
  }
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return timezone;
  } catch {
    throw new Error(`invalid_timezone:${timezone}`);
  }
}

export function localDateString(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(instant);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  return `${year}-${month}-${day}`;
}

export function localHourBucket(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hour12: false
  }).formatToParts(instant);
  const year = parts.find((p) => p.type === "year")?.value;
  const month = parts.find((p) => p.type === "month")?.value;
  const day = parts.find((p) => p.type === "day")?.value;
  let hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  if (hour === "24") {
    hour = "00";
  }
  return `${year}-${month}-${day}T${hour.padStart(2, "0")}:00`;
}

export function localTimeOfDay(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(instant);
  let hour = parts.find((p) => p.type === "hour")?.value ?? "00";
  const minute = parts.find((p) => p.type === "minute")?.value ?? "00";
  if (hour === "24") {
    hour = "00";
  }
  return `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;
}

export function localDateRangeEndingToday(rangeDays: number, timeZone: string, now = new Date()): {
  rangeStart: string;
  rangeEnd: string;
} {
  const rangeEnd = localDateString(now, timeZone);
  const endUtc = Date.parse(`${rangeEnd}T12:00:00.000Z`);
  const startUtc = endUtc - (rangeDays - 1) * 24 * 60 * 60 * 1000;
  const rangeStart = localDateString(new Date(startUtc), "UTC");
  return { rangeStart, rangeEnd };
}

export function isDateInInclusiveRange(date: string, rangeStart: string, rangeEnd: string): boolean {
  return date >= rangeStart && date <= rangeEnd;
}
