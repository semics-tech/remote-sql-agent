import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import {
  generateCommandSigningKeyPair,
  signCommand,
  toTimestamp,
  type Command,
} from '@remote-sql-agent/protocol';
import { Outbox } from '../src/outbox.js';
import { handleCommand } from '../src/command-handler.js';

/**
 * `handleCommand`'s dispatch of the schedule and operator command kinds.
 *
 * Two bugs the review found in the same area: `upsertSchedule`/`upsertOperator`
 * ran `JSON.parse` outside any try/catch, unlike every other payload parse in
 * this file — a malformed `canonicalJson` threw past the command's own error
 * handling instead of coming back as a refused command, so the command simply
 * never got a result and sat "dispatched" until it expired. And `deleteSchedule`
 * passed a field the wire protocol used to call `scheduleUuid` into a worker
 * function that binds it to `@schedule_name` — msdb schedules have no GUID,
 * only a name, so this was never a UUID at all; the field is `scheduleName` now.
 */

const upsertScheduleMock = vi.fn(async (..._args: unknown[]) => undefined);
const deleteScheduleMock = vi.fn(async (..._args: unknown[]) => undefined);
const upsertOperatorMock = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../src/sql/agent-writer.js', () => ({
  upsertSchedule: (...args: unknown[]) => upsertScheduleMock(...args),
  deleteSchedule: (...args: unknown[]) => deleteScheduleMock(...args),
  upsertOperator: (...args: unknown[]) => upsertOperatorMock(...args),
  toggleJob: vi.fn(),
  startJob: vi.fn(),
  stopJob: vi.fn(),
  upsertJob: vi.fn(),
  deleteJob: vi.fn(),
  setJobWriteAllowed: vi.fn(),
  SqlApplyError: class SqlApplyError extends Error {},
}));

vi.mock('../src/sql/agent-repo.js', () => ({
  readJobs: vi.fn(async () => []),
}));

const { privateKeyPem, publicKeyPem } = generateCommandSigningKeyPair();
const logger = pino({ level: 'silent' });

let dir: string;
let outbox: Outbox;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rsagent-cmdhandler-'));
  outbox = new Outbox(join(dir, 'outbox.sqlite'), 100);
  upsertScheduleMock.mockClear();
  deleteScheduleMock.mockClear();
  upsertOperatorMock.mockClear();
});

afterEach(() => {
  outbox.close();
  rmSync(dir, { recursive: true, force: true });
});

function context(capability: string) {
  return {
    pool: {} as never,
    instanceName: 'INST1',
    capabilities: ['observe', capability] as never,
    outbox,
    logger,
    commandSigningPublicKey: publicKeyPem,
  };
}

function command(
  id: string,
  payload: Command['payload'],
): Command {
  const base: Command = {
    id,
    issuedAt: toTimestamp(new Date()),
    instanceName: 'INST1',
    signature: new Uint8Array(),
    payload,
  };
  const signature = signCommand(base, privateKeyPem);
  return { ...base, signature };
}

describe('upsertSchedule: malformed JSON is refused, not thrown', () => {
  it('refuses cleanly rather than crashing the command queue', async () => {
    const cmd = command('11111111-1111-4111-8111-111111111111', {
      $case: 'upsertSchedule',
      upsertSchedule: { scheduleName: 'nightly', canonicalJson: '{not valid json', baseDefinitionHash: '' },
    });

    const result = await handleCommand(cmd, context('schedule.write'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('Invalid');
    expect(upsertScheduleMock).not.toHaveBeenCalled();
  });

  it('applies a well-formed schedule normally', async () => {
    const canonicalJson = JSON.stringify({
      name: 'nightly',
      enabled: true,
      freqType: 4,
      freqInterval: 1,
      freqSubdayType: 1,
      freqSubdayInterval: 0,
      freqRelativeInterval: 0,
      freqRecurrenceFactor: 0,
      activeStartDate: 20260101,
      activeEndDate: 99991231,
      activeStartTime: 20000,
      activeEndTime: 235959,
    });
    const cmd = command('22222222-2222-4222-8222-222222222222', {
      $case: 'upsertSchedule',
      upsertSchedule: { scheduleName: 'nightly', canonicalJson, baseDefinitionHash: '' },
    });

    const result = await handleCommand(cmd, context('schedule.write'));

    expect(result.success).toBe(true);
    expect(upsertScheduleMock).toHaveBeenCalledOnce();
    expect(upsertScheduleMock.mock.calls[0]![1]).toMatchObject({ name: 'nightly' });
  });
});

describe('upsertOperator: malformed JSON is refused, not thrown', () => {
  it('refuses cleanly rather than crashing the command queue', async () => {
    const cmd = command('33333333-3333-4333-8333-333333333333', {
      $case: 'upsertOperator',
      upsertOperator: { operatorId: 0, canonicalJson: '{{{', baseDefinitionHash: '' },
    });

    const result = await handleCommand(cmd, context('operator.write'));

    expect(result.success).toBe(false);
    expect(result.errorCode).toBe('Invalid');
    expect(upsertOperatorMock).not.toHaveBeenCalled();
  });
});

describe('deleteSchedule targets the schedule by name', () => {
  it('passes the command payload\'s scheduleName straight through, not some other field', async () => {
    const cmd = command('44444444-4444-4444-8444-444444444444', {
      $case: 'deleteSchedule',
      deleteSchedule: { scheduleName: 'legacy-nightly', baseDefinitionHash: '' },
    });

    const result = await handleCommand(cmd, context('schedule.write'));

    expect(result.success).toBe(true);
    expect(deleteScheduleMock).toHaveBeenCalledWith(expect.anything(), 'legacy-nightly');
  });
});
