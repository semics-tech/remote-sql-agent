import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { assertWebhookUrl, assertWebhookUrlAllowed } from '../src/domain/notifications/senders.js';

/**
 * Controls whose safe value is "on", and what happens when they are set wrong.
 *
 * The shared failure mode is that a setting looks right, is not understood, and
 * quietly resolves to the unsafe reading. Nothing logs, nothing refuses, and the
 * operator has no way to find out — which is the property being removed here.
 */

const BASE = {
  RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
  RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
} as NodeJS.ProcessEnv;

describe('boolean environment variables', () => {
  it.each([
    ['True', true],
    ['TRUE', true],
    ['  true  ', true],
    ['yes', true],
    ['On', true],
    ['1', true],
    ['False', false],
    ['off', false],
    ['0', false],
    ['NO', false],
  ])('accepts %s', (value, expected) => {
    const config = loadConfig({ ...BASE, RSAGENT_GRPC_REQUIRE_TLS: value });
    expect(config.workerAuth.requireTls).toBe(expected);
  });

  it('refuses to start on a value it does not understand', () => {
    // The bug this replaces: anything unrecognised became `false`. So
    // `RSAGENT_GRPC_REQUIRE_TLS=True` — which reads as correct in a compose
    // file — started the hub in plaintext with worker API keys on the wire, and
    // said nothing. A typo that disables a security control has to be loud.
    expect(() => loadConfig({ ...BASE, RSAGENT_GRPC_REQUIRE_TLS: 'maybe' })).toThrow(
      /RSAGENT_GRPC_REQUIRE_TLS must be a boolean/u,
    );
    expect(() => loadConfig({ ...BASE, RSAGENT_REQUIRE_APPROVAL_JOB_WRITE: 'enabled' })).toThrow(
      /RSAGENT_REQUIRE_APPROVAL_JOB_WRITE/u,
    );
  });

  it('names the variable, so the message points at the line to change', () => {
    expect(() => loadConfig({ ...BASE, RSAGENT_AUDIT_OTLP_ENABLED: 'sure' })).toThrow(
      /RSAGENT_AUDIT_OTLP_ENABLED.*"sure"/su,
    );
  });

  it('keeps the safe default when the variable is absent', () => {
    const config = loadConfig(BASE);
    expect(config.workerAuth.requireTls).toBe(true);
    expect(config.requireApprovalForJobWrite).toBe(false);
  });
});

describe('where a webhook may be pointed', () => {
  it('allows the internal targets this product exists to serve', () => {
    // RFC1918 is the *normal* case for a tool that lives inside the firewall.
    // Blocking it would break the primary use case and become a flag every
    // estate turns off.
    for (const url of [
      'https://hooks.internal.corp/services/abc',
      'http://10.4.2.9:8080/notify',
      'http://192.168.1.50/webhook',
      'http://localhost:9000/hook',
      'https://hooks.slack.com/services/T/B/X',
    ]) {
      expect(() => assertWebhookUrlAllowed(url, 'Webhook'), url).not.toThrow();
    }
  });

  it('refuses the link-local range where cloud metadata lives', () => {
    for (const url of [
      'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
      'http://169.254.170.2/v2/credentials',
      'http://[fe80::1]/',
      'http://metadata.google.internal/computeMetadata/v1/',
    ]) {
      expect(() => assertWebhookUrlAllowed(url, 'Webhook'), url).toThrow(/link-local/u);
    }
  });

  it('refuses the encodings a naive string check misses', () => {
    // `new URL()` normalises the decimal, octal and hex spellings back to the
    // dotted quad, so those need no pattern of their own — asserted here so
    // nobody adds three dead ones back.
    for (const url of [
      'http://2852039166/',
      'http://0xa9fea9fe/',
      'http://0251.0376.0251.0376/',
    ]) {
      expect(new URL(url).hostname, url).toBe('169.254.169.254');
      expect(() => assertWebhookUrlAllowed(url, 'Webhook'), url).toThrow(/link-local/u);
    }

    // This one genuinely does need its own pattern: it does not survive as a
    // dotted quad. `new URL()` renders it `[::ffff:a9fe:a9fe]`, so a check
    // written against `::ffff:169.254.` would miss every one of these.
    const mapped = 'http://[::ffff:169.254.169.254]/';
    expect(new URL(mapped).hostname).toBe('[::ffff:a9fe:a9fe]');
    expect(() => assertWebhookUrlAllowed(mapped, 'Webhook')).toThrow(/link-local/u);
  });

  it('refuses a scheme that is not http or https', () => {
    expect(() => assertWebhookUrlAllowed('file:///etc/passwd', 'Webhook')).toThrow(/http or https/u);
    expect(() => assertWebhookUrlAllowed('gopher://host/', 'Webhook')).toThrow(/http or https/u);
  });

  it('refuses something that is not a URL at all', () => {
    expect(() => assertWebhookUrlAllowed('not a url', 'Webhook')).toThrow(/not a valid URL/u);
  });

  it('applies the same rule when the channel is saved, not only when it sends', () => {
    // Validating only the scheme on save meant a channel pointed at the
    // metadata service saved cleanly and was refused later, somewhere the
    // administrator was not looking — which makes it read as a delivery quirk
    // rather than a rule about what may be configured.
    expect(() => assertWebhookUrl('http://169.254.169.254/latest/meta-data/')).toThrow(
      /link-local/u,
    );
    expect(() => assertWebhookUrl('file:///etc/passwd')).toThrow(/http or https/u);
    expect(() => assertWebhookUrl('https://hooks.internal.corp/x')).not.toThrow();
  });
});
