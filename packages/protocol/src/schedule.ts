import { z } from 'zod';

/**
 * SQL Server Agent schedule encoding.
 *
 * We store the `freq_*` parameter model from `sp_add_schedule` faithfully and
 * without reinterpretation — it *is* the on-prem truth, and any lossy
 * abstraction would break round-trip fidelity. The humane model below is a
 * derived view for the UI, never the stored form.
 *
 * Reference: msdb.dbo.sysschedules / sp_add_schedule.
 */

export const FreqType = {
  Once: 1,
  Daily: 4,
  Weekly: 8,
  Monthly: 16,
  MonthlyRelative: 32,
  OnAgentStart: 64,
  OnIdle: 128,
} as const;
export type FreqTypeValue = (typeof FreqType)[keyof typeof FreqType];

export const FreqSubdayType = {
  /** Fires once, at active_start_time. */
  AtSpecifiedTime: 1,
  Seconds: 2,
  Minutes: 4,
  Hours: 8,
} as const;
export type FreqSubdayTypeValue = (typeof FreqSubdayType)[keyof typeof FreqSubdayType];

/** freq_relative_interval, used only when freq_type = MonthlyRelative. */
export const RelativeInterval = {
  First: 1,
  Second: 2,
  Third: 4,
  Fourth: 8,
  Last: 16,
} as const;

/**
 * Weekday bit flags used by freq_interval when freq_type = Weekly.
 * Note these are *not* the same numbering as freq_interval under
 * MonthlyRelative, which uses 1..7 for Sun..Sat plus 8/9/10 for
 * day/weekday/weekend-day. A frequent source of bugs; kept separate.
 */
export const WeekdayFlag = {
  Sunday: 1,
  Monday: 2,
  Tuesday: 4,
  Wednesday: 8,
  Thursday: 16,
  Friday: 32,
  Saturday: 64,
} as const;

/** freq_interval values when freq_type = MonthlyRelative. */
export const RelativeWeekday = {
  Sunday: 1,
  Monday: 2,
  Tuesday: 3,
  Wednesday: 4,
  Thursday: 5,
  Friday: 6,
  Saturday: 7,
  Day: 8,
  Weekday: 9,
  WeekendDay: 10,
} as const;

export const scheduleDefinitionSchema = z.object({
  name: z.string().min(1).max(128),
  enabled: z.boolean(),
  freqType: z.number().int(),
  freqInterval: z.number().int(),
  freqSubdayType: z.number().int(),
  freqSubdayInterval: z.number().int(),
  freqRelativeInterval: z.number().int(),
  freqRecurrenceFactor: z.number().int(),
  /** yyyymmdd, as stored. */
  activeStartDate: z.number().int(),
  /** yyyymmdd; 99991231 means "no end date". */
  activeEndDate: z.number().int(),
  /** hhmmss, as stored (e.g. 143000 = 14:30:00). */
  activeStartTime: z.number().int(),
  /** hhmmss; 235959 means "no end time". */
  activeEndTime: z.number().int(),
});

export type ScheduleDefinition = z.infer<typeof scheduleDefinitionSchema>;

// ---------------------------------------------------------------------------
// Encoded <-> humane conversion (UI only; never the stored form)
// ---------------------------------------------------------------------------

export type HumaneRecurrence =
  | { kind: 'once' }
  | { kind: 'onAgentStart' }
  | { kind: 'onIdle' }
  | { kind: 'daily'; everyNDays: number }
  | { kind: 'weekly'; everyNWeeks: number; weekdays: Array<keyof typeof WeekdayFlag> }
  | { kind: 'monthly'; dayOfMonth: number; everyNMonths: number }
  | {
      kind: 'monthlyRelative';
      occurrence: keyof typeof RelativeInterval;
      weekday: keyof typeof RelativeWeekday;
      everyNMonths: number;
    };

export type HumaneDailyFrequency =
  | { kind: 'once'; at: string }
  | { kind: 'every'; interval: number; unit: 'seconds' | 'minutes' | 'hours'; from: string; to: string };

export interface HumaneSchedule {
  recurrence: HumaneRecurrence;
  dailyFrequency: HumaneDailyFrequency;
  startDate: string; // yyyy-mm-dd
  endDate: string | null; // null when active_end_date is 99991231
}

/** hhmmss integer -> "HH:MM:SS". */
export function decodeTime(t: number): string {
  const s = Math.max(0, Math.trunc(t)).toString().padStart(6, '0');
  return `${s.slice(0, 2)}:${s.slice(2, 4)}:${s.slice(4, 6)}`;
}

/** "HH:MM:SS" or "HH:MM" -> hhmmss integer. */
export function encodeTime(hhmmss: string): number {
  const parts = hhmmss.split(':');
  const h = Number(parts[0] ?? 0);
  const m = Number(parts[1] ?? 0);
  const s = Number(parts[2] ?? 0);
  return h * 10000 + m * 100 + s;
}

/** yyyymmdd integer -> "yyyy-mm-dd". */
export function decodeDate(d: number): string {
  const s = Math.max(0, Math.trunc(d)).toString().padStart(8, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
}

/** "yyyy-mm-dd" -> yyyymmdd integer. */
export function encodeDate(iso: string): number {
  return Number(iso.replaceAll('-', ''));
}

const WEEKDAY_ENTRIES = Object.entries(WeekdayFlag) as Array<[keyof typeof WeekdayFlag, number]>;
const RELATIVE_INTERVAL_ENTRIES = Object.entries(RelativeInterval) as Array<
  [keyof typeof RelativeInterval, number]
>;
const RELATIVE_WEEKDAY_ENTRIES = Object.entries(RelativeWeekday) as Array<
  [keyof typeof RelativeWeekday, number]
>;

export function toHumaneSchedule(s: ScheduleDefinition): HumaneSchedule {
  let recurrence: HumaneRecurrence;
  switch (s.freqType) {
    case FreqType.Once:
      recurrence = { kind: 'once' };
      break;
    case FreqType.OnAgentStart:
      recurrence = { kind: 'onAgentStart' };
      break;
    case FreqType.OnIdle:
      recurrence = { kind: 'onIdle' };
      break;
    case FreqType.Daily:
      recurrence = { kind: 'daily', everyNDays: s.freqInterval };
      break;
    case FreqType.Weekly:
      recurrence = {
        kind: 'weekly',
        everyNWeeks: s.freqRecurrenceFactor,
        weekdays: WEEKDAY_ENTRIES.filter(([, bit]) => (s.freqInterval & bit) !== 0).map(([n]) => n),
      };
      break;
    case FreqType.Monthly:
      recurrence = {
        kind: 'monthly',
        dayOfMonth: s.freqInterval,
        everyNMonths: s.freqRecurrenceFactor,
      };
      break;
    case FreqType.MonthlyRelative: {
      const occurrence =
        RELATIVE_INTERVAL_ENTRIES.find(([, v]) => v === s.freqRelativeInterval)?.[0] ?? 'First';
      const weekday = RELATIVE_WEEKDAY_ENTRIES.find(([, v]) => v === s.freqInterval)?.[0] ?? 'Day';
      recurrence = {
        kind: 'monthlyRelative',
        occurrence,
        weekday,
        everyNMonths: s.freqRecurrenceFactor,
      };
      break;
    }
    default:
      recurrence = { kind: 'once' };
  }

  const dailyFrequency: HumaneDailyFrequency =
    s.freqSubdayType === FreqSubdayType.AtSpecifiedTime
      ? { kind: 'once', at: decodeTime(s.activeStartTime) }
      : {
          kind: 'every',
          interval: s.freqSubdayInterval,
          unit:
            s.freqSubdayType === FreqSubdayType.Seconds
              ? 'seconds'
              : s.freqSubdayType === FreqSubdayType.Hours
                ? 'hours'
                : 'minutes',
          from: decodeTime(s.activeStartTime),
          to: decodeTime(s.activeEndTime),
        };

  return {
    recurrence,
    dailyFrequency,
    startDate: decodeDate(s.activeStartDate),
    endDate: s.activeEndDate === 99991231 ? null : decodeDate(s.activeEndDate),
  };
}

export function fromHumaneSchedule(
  name: string,
  enabled: boolean,
  h: HumaneSchedule,
): ScheduleDefinition {
  let freqType: number = FreqType.Once;
  let freqInterval = 0;
  let freqRelativeInterval = 0;
  let freqRecurrenceFactor = 0;

  switch (h.recurrence.kind) {
    case 'once':
      freqType = FreqType.Once;
      freqInterval = 0;
      break;
    case 'onAgentStart':
      freqType = FreqType.OnAgentStart;
      freqInterval = 0;
      break;
    case 'onIdle':
      freqType = FreqType.OnIdle;
      freqInterval = 0;
      break;
    case 'daily':
      freqType = FreqType.Daily;
      freqInterval = h.recurrence.everyNDays;
      break;
    case 'weekly':
      freqType = FreqType.Weekly;
      freqInterval = h.recurrence.weekdays.reduce((acc, d) => acc | WeekdayFlag[d], 0);
      freqRecurrenceFactor = h.recurrence.everyNWeeks;
      break;
    case 'monthly':
      freqType = FreqType.Monthly;
      freqInterval = h.recurrence.dayOfMonth;
      freqRecurrenceFactor = h.recurrence.everyNMonths;
      break;
    case 'monthlyRelative':
      freqType = FreqType.MonthlyRelative;
      freqInterval = RelativeWeekday[h.recurrence.weekday];
      freqRelativeInterval = RelativeInterval[h.recurrence.occurrence];
      freqRecurrenceFactor = h.recurrence.everyNMonths;
      break;
  }

  const subday = h.dailyFrequency;
  const freqSubdayType =
    subday.kind === 'once'
      ? FreqSubdayType.AtSpecifiedTime
      : subday.unit === 'seconds'
        ? FreqSubdayType.Seconds
        : subday.unit === 'hours'
          ? FreqSubdayType.Hours
          : FreqSubdayType.Minutes;

  return {
    name,
    enabled,
    freqType,
    freqInterval,
    freqSubdayType,
    freqSubdayInterval: subday.kind === 'once' ? 0 : subday.interval,
    freqRelativeInterval,
    freqRecurrenceFactor,
    activeStartDate: encodeDate(h.startDate),
    activeEndDate: h.endDate === null ? 99991231 : encodeDate(h.endDate),
    activeStartTime: subday.kind === 'once' ? encodeTime(subday.at) : encodeTime(subday.from),
    activeEndTime: subday.kind === 'once' ? 235959 : encodeTime(subday.to),
  };
}

/** SSMS-style one-line summary, e.g. "Occurs every week on Monday, Friday at 02:00:00". */
export function describeSchedule(s: ScheduleDefinition): string {
  const h = toHumaneSchedule(s);
  let base: string;
  switch (h.recurrence.kind) {
    case 'once':
      base = `Occurs once on ${h.startDate}`;
      break;
    case 'onAgentStart':
      return 'Occurs when SQL Server Agent starts';
    case 'onIdle':
      return 'Occurs when the CPU becomes idle';
    case 'daily':
      base =
        h.recurrence.everyNDays === 1
          ? 'Occurs every day'
          : `Occurs every ${h.recurrence.everyNDays} days`;
      break;
    case 'weekly': {
      const every =
        h.recurrence.everyNWeeks === 1 ? 'every week' : `every ${h.recurrence.everyNWeeks} weeks`;
      const days = h.recurrence.weekdays.length ? h.recurrence.weekdays.join(', ') : 'no days';
      base = `Occurs ${every} on ${days}`;
      break;
    }
    case 'monthly': {
      const every =
        h.recurrence.everyNMonths === 1
          ? 'every month'
          : `every ${h.recurrence.everyNMonths} months`;
      base = `Occurs ${every} on day ${h.recurrence.dayOfMonth}`;
      break;
    }
    case 'monthlyRelative': {
      const every =
        h.recurrence.everyNMonths === 1
          ? 'every month'
          : `every ${h.recurrence.everyNMonths} months`;
      base = `Occurs ${every} on the ${h.recurrence.occurrence.toLowerCase()} ${h.recurrence.weekday}`;
      break;
    }
  }

  const when =
    h.dailyFrequency.kind === 'once'
      ? ` at ${h.dailyFrequency.at}`
      : ` every ${h.dailyFrequency.interval} ${h.dailyFrequency.unit} between ${h.dailyFrequency.from} and ${h.dailyFrequency.to}`;

  return base + when;
}
