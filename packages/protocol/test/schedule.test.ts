import { describe, expect, it } from 'vitest';
import {
  FreqType,
  FreqSubdayType,
  WeekdayFlag,
  RelativeInterval,
  RelativeWeekday,
  decodeTime,
  encodeTime,
  decodeDate,
  encodeDate,
  toHumaneSchedule,
  fromHumaneSchedule,
  describeSchedule,
  type ScheduleDefinition,
} from '../src/schedule.js';
import { schedule, complexSchedule } from './fixtures.js';

describe('time and date codecs', () => {
  const times: Array<[number, string]> = [
    [0, '00:00:00'],
    [1, '00:00:01'],
    [130, '00:01:30'],
    [20000, '02:00:00'],
    [143000, '14:30:00'],
    [235959, '23:59:59'],
  ];

  it.each(times)('decodes %i to %s', (encoded, iso) => {
    expect(decodeTime(encoded)).toBe(iso);
  });

  it.each(times)('encodes %s back to %i', (encoded, iso) => {
    expect(encodeTime(iso)).toBe(encoded);
  });

  it('accepts HH:MM without seconds', () => {
    expect(encodeTime('14:30')).toBe(143000);
  });

  const dates: Array<[number, string]> = [
    [20240101, '2024-01-01'],
    [19991231, '1999-12-31'],
    [99991231, '9999-12-31'],
  ];

  it.each(dates)('round-trips date %i <-> %s', (encoded, iso) => {
    expect(decodeDate(encoded)).toBe(iso);
    expect(encodeDate(iso)).toBe(encoded);
  });
});

/**
 * Table-driven coverage of the freq_* model. These encodings are the single
 * fiddliest part of SQL Agent and the place a subtle bug would silently
 * reschedule production jobs, so every freq_type is covered explicitly.
 */
describe('freq_* encoding', () => {
  const cases: Array<{ name: string; encoded: Partial<ScheduleDefinition>; expect: (h: ReturnType<typeof toHumaneSchedule>) => void }> = [
    {
      name: 'one time only',
      encoded: { freqType: FreqType.Once, freqInterval: 0 },
      expect: (h) => expect(h.recurrence).toEqual({ kind: 'once' }),
    },
    {
      // sp_add_schedule stores freq_interval = 0 for the schedule types that
      // have no interval to speak of; the fixture default of 1 would not occur.
      name: 'when SQL Server Agent starts',
      encoded: { freqType: FreqType.OnAgentStart, freqInterval: 0 },
      expect: (h) => expect(h.recurrence).toEqual({ kind: 'onAgentStart' }),
    },
    {
      name: 'when the CPU becomes idle',
      encoded: { freqType: FreqType.OnIdle, freqInterval: 0 },
      expect: (h) => expect(h.recurrence).toEqual({ kind: 'onIdle' }),
    },
    {
      name: 'every day',
      encoded: { freqType: FreqType.Daily, freqInterval: 1 },
      expect: (h) => expect(h.recurrence).toEqual({ kind: 'daily', everyNDays: 1 }),
    },
    {
      name: 'every 3 days',
      encoded: { freqType: FreqType.Daily, freqInterval: 3 },
      expect: (h) => expect(h.recurrence).toEqual({ kind: 'daily', everyNDays: 3 }),
    },
    {
      name: 'weekly on Mon/Fri every 2 weeks',
      encoded: {
        freqType: FreqType.Weekly,
        freqInterval: WeekdayFlag.Monday | WeekdayFlag.Friday,
        freqRecurrenceFactor: 2,
      },
      expect: (h) =>
        expect(h.recurrence).toEqual({
          kind: 'weekly',
          everyNWeeks: 2,
          weekdays: ['Monday', 'Friday'],
        }),
    },
    {
      name: 'weekly on every day of the week',
      encoded: { freqType: FreqType.Weekly, freqInterval: 127, freqRecurrenceFactor: 1 },
      expect: (h) => {
        expect(h.recurrence.kind).toBe('weekly');
        if (h.recurrence.kind === 'weekly') expect(h.recurrence.weekdays).toHaveLength(7);
      },
    },
    {
      name: 'monthly on day 15',
      encoded: { freqType: FreqType.Monthly, freqInterval: 15, freqRecurrenceFactor: 1 },
      expect: (h) =>
        expect(h.recurrence).toEqual({ kind: 'monthly', dayOfMonth: 15, everyNMonths: 1 }),
    },
    {
      name: 'monthly relative: last weekday, every 3 months',
      encoded: {
        freqType: FreqType.MonthlyRelative,
        freqInterval: RelativeWeekday.Weekday,
        freqRelativeInterval: RelativeInterval.Last,
        freqRecurrenceFactor: 3,
      },
      expect: (h) =>
        expect(h.recurrence).toEqual({
          kind: 'monthlyRelative',
          occurrence: 'Last',
          weekday: 'Weekday',
          everyNMonths: 3,
        }),
    },
    {
      name: 'monthly relative: second Tuesday',
      encoded: {
        freqType: FreqType.MonthlyRelative,
        freqInterval: RelativeWeekday.Tuesday,
        freqRelativeInterval: RelativeInterval.Second,
        freqRecurrenceFactor: 1,
      },
      expect: (h) =>
        expect(h.recurrence).toEqual({
          kind: 'monthlyRelative',
          occurrence: 'Second',
          weekday: 'Tuesday',
          everyNMonths: 1,
        }),
    },
  ];

  it.each(cases)('decodes $name', ({ encoded, expect: assert }) => {
    assert(toHumaneSchedule(schedule(encoded)));
  });

  it.each(cases)('round-trips $name through the humane model', ({ encoded }) => {
    const original = schedule(encoded);
    const rebuilt = fromHumaneSchedule(original.name, original.enabled, toHumaneSchedule(original));
    expect(rebuilt).toEqual(original);
  });
});

describe('sub-day frequency', () => {
  it('decodes "occurs once at" schedules', () => {
    const h = toHumaneSchedule(
      schedule({ freqSubdayType: FreqSubdayType.AtSpecifiedTime, activeStartTime: 20000 }),
    );
    expect(h.dailyFrequency).toEqual({ kind: 'once', at: '02:00:00' });
  });

  it.each([
    [FreqSubdayType.Seconds, 'seconds'],
    [FreqSubdayType.Minutes, 'minutes'],
    [FreqSubdayType.Hours, 'hours'],
  ] as const)('decodes recurring sub-day type %i as %s', (subdayType, unit) => {
    const h = toHumaneSchedule(
      schedule({
        freqSubdayType: subdayType,
        freqSubdayInterval: 15,
        activeStartTime: 80000,
        activeEndTime: 180000,
      }),
    );
    expect(h.dailyFrequency).toEqual({
      kind: 'every',
      interval: 15,
      unit,
      from: '08:00:00',
      to: '18:00:00',
    });
  });
});

describe('end date', () => {
  it('treats 99991231 as no end date', () => {
    expect(toHumaneSchedule(schedule({ activeEndDate: 99991231 })).endDate).toBeNull();
  });

  it('preserves a real end date', () => {
    expect(toHumaneSchedule(schedule({ activeEndDate: 20261231 })).endDate).toBe('2026-12-31');
  });

  it('re-encodes a null end date back to 99991231', () => {
    const s = schedule({ activeEndDate: 99991231 });
    expect(fromHumaneSchedule(s.name, s.enabled, toHumaneSchedule(s)).activeEndDate).toBe(99991231);
  });
});

describe('describeSchedule', () => {
  it('renders a daily schedule the way SSMS would', () => {
    expect(describeSchedule(schedule())).toBe('Occurs every day at 02:00:00');
  });

  it('renders a complex weekly schedule', () => {
    expect(describeSchedule(complexSchedule())).toBe(
      'Occurs every 2 weeks on Monday, Wednesday, Friday every 30 minutes between 08:00:00 and 18:00:00',
    );
  });

  it('renders agent-start and idle schedules without a time clause', () => {
    expect(describeSchedule(schedule({ freqType: FreqType.OnAgentStart }))).toBe(
      'Occurs when SQL Server Agent starts',
    );
    expect(describeSchedule(schedule({ freqType: FreqType.OnIdle }))).toBe(
      'Occurs when the CPU becomes idle',
    );
  });
});
