// Time helpers. All date math lives in code, never in the model.

export function systemTz(): string {
  return process.env.DEFAULT_TZ || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function isValidTz(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

type Parts = { y: number; m: number; d: number; h: number; mi: number; s: number };

function parts(date: Date, tz: string): Parts {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const o: Record<string, number> = {};
  for (const p of f.formatToParts(date)) if (p.type !== "literal") o[p.type] = Number(p.value);
  return { y: o.year, m: o.month, d: o.day, h: o.hour, mi: o.minute, s: o.second };
}

/** Offset of `tz` from UTC at `date`, in minutes (e.g. IST = 330). */
export function tzOffsetMinutes(date: Date, tz: string): number {
  const p = parts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

export function startOfDay(date: Date, tz: string): Date {
  const p = parts(date, tz);
  const localMidnightAsUtc = Date.UTC(p.y, p.m - 1, p.d);
  const off = tzOffsetMinutes(new Date(localMidnightAsUtc), tz);
  return new Date(localMidnightAsUtc - off * 60_000);
}

export function endOfDay(date: Date, tz: string): Date {
  const next = new Date(startOfDay(date, tz).getTime() + 36 * 3600_000); // safely inside next day
  return new Date(startOfDay(next, tz).getTime() - 1);
}

/** "Mon 10 Nov 2026, 14:02" in tz. */
export function fmt(date: Date | number, tz: string): string {
  const d = typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(d)
    .replace(",", "");
}

/** "Mon 10 Nov 2026" in tz. */
export function fmtDay(date: Date | number, tz: string): string {
  const d = typeof date === "number" ? new Date(date) : date;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
  })
    .format(d)
    .replace(",", "");
}

/** YYYY-MM-DD in tz (what search APIs want). */
export function isoDay(date: Date | number, tz: string): string {
  const d = typeof date === "number" ? new Date(date) : date;
  const p = parts(d, tz);
  return `${p.y}-${String(p.m).padStart(2, "0")}-${String(p.d).padStart(2, "0")}`;
}
