import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { hubAddress, installCommands } from '../src/api/app.js';

/**
 * These two functions produce the string an admin pastes into an elevated
 * prompt on a production SQL host, and it is copied verbatim into `worker.yaml`
 * on every machine in the estate. Getting it wrong is not a broken page: a
 * worker pointed at the wrong port retries on backoff forever while the
 * dashboard just shows it as never having connected, which looks like a
 * networking problem for as long as anyone is willing to keep looking.
 *
 * Neither function touches the database, so this exercises them directly.
 */

function configFor(env: Record<string, string>) {
  return loadConfig({
    RSAGENT_DATABASE_URL: 'postgres://x:y@localhost:5432/z',
    RSAGENT_GRPC_REQUIRE_TLS: 'false',
    ...env,
  } as NodeJS.ProcessEnv);
}

describe('hubAddress', () => {
  it('derives host from the public URL and port from the hub', () => {
    // Not the bind address: grpcHost is 0.0.0.0, and a worker told to dial
    // 0.0.0.0 connects to itself.
    const address = hubAddress(
      configFor({ RSAGENT_PUBLIC_URL: 'https://rsagent.example.com', RSAGENT_GRPC_PORT: '8443' }),
    );
    expect(address).toBe('rsagent.example.com:8443');
  });

  it('ignores a port on the public URL, which belongs to the dashboard', () => {
    const address = hubAddress(
      configFor({ RSAGENT_PUBLIC_URL: 'https://rsagent.example.com:8080', RSAGENT_GRPC_PORT: '8443' }),
    );
    expect(address).toBe('rsagent.example.com:8443');
  });

  it('returns the override verbatim', () => {
    // The case the override exists for: a platform publishing the hub on a
    // different outside port from the one the process bound.
    const address = hubAddress(
      configFor({
        RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
        RSAGENT_GRPC_PORT: '8443',
        RSAGENT_HUB_ADVERTISED_ADDRESS: 'hub.example.com:443',
      }),
    );
    expect(address).toBe('hub.example.com:443');
  });

  it('keeps the brackets on an IPv6 public URL', () => {
    // `new URL(...).hostname` returns "[2001:db8::1]" with brackets, which is
    // the form gRPC needs to tell the address apart from the port. This looks
    // like a stray bracket bug and removing it would break every IPv6 install.
    const address = hubAddress(
      configFor({ RSAGENT_PUBLIC_URL: 'https://[2001:db8::1]', RSAGENT_GRPC_PORT: '8443' }),
    );
    expect(address).toBe('[2001:db8::1]:8443');
  });

  it('rejects an override without a port rather than guessing one', () => {
    // Appending grpcPort would silently reintroduce the exact mismatch the
    // override exists to fix, on a value nobody would think to re-check.
    expect(() =>
      configFor({
        RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
        RSAGENT_HUB_ADVERTISED_ADDRESS: 'hub.example.com',
      }),
    ).toThrow(/host:port/u);
  });

  it('rejects an override with a port outside the valid range', () => {
    expect(() =>
      configFor({
        RSAGENT_PUBLIC_URL: 'https://rsagent.example.com',
        RSAGENT_HUB_ADVERTISED_ADDRESS: 'hub.example.com:70000',
      }),
    ).toThrow(/host:port/u);
  });
});

describe('installCommands', () => {
  const token = 'rsen_test';

  it('stays short when the scripts can find the package themselves', () => {
    // Hub and dashboard on the same host, dashboard on 443: exactly what
    // bootstrap.sh and bootstrap.ps1 assume, so saying it again is noise.
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'rsagent.example.com:8443',
      publicUrl: 'https://rsagent.example.com',
    });
    expect(commands.linux).not.toContain('--package-url');
    expect(commands.windows).not.toContain('-PackageUrl');
    expect(commands.linux).toContain("--control-plane 'rsagent.example.com:8443'");
  });

  it('spells out the package URL when the hub has its own hostname', () => {
    // The scripts would strip the port off --control-plane and fetch from
    // https://hub.example.com/downloads/..., which serves no packages.
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'hub.example.com:8443',
      publicUrl: 'https://dashboard.example.com',
    });
    expect(commands.linux).toContain(
      "--package-url 'https://dashboard.example.com/downloads/rsagent-worker-linux.tar.gz'",
    );
    expect(commands.windows).toContain(
      "-PackageUrl 'https://dashboard.example.com/downloads/rsagent-worker-windows.zip'",
    );
  });

  it('spells out the package URL when the dashboard is not on 443', () => {
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'rsagent.example.com:8443',
      publicUrl: 'https://rsagent.example.com:8080',
    });
    expect(commands.linux).toContain(
      "--package-url 'https://rsagent.example.com:8080/downloads/rsagent-worker-linux.tar.gz'",
    );
  });

  it('spells out the package URL over plain HTTP', () => {
    // The scripts hardcode https:// when they guess, so a lab running over
    // http would otherwise be sent to a URL that does not answer.
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'rsagent.example.com:8443',
      publicUrl: 'http://rsagent.example.com',
    });
    expect(commands.linux).toContain("--package-url 'http://rsagent.example.com/downloads/");
  });

  it('treats an explicit :443 as the default port', () => {
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'rsagent.example.com:8443',
      publicUrl: 'https://rsagent.example.com:443',
    });
    expect(commands.linux).not.toContain('--package-url');
  });

  it('does not leave a trailing slash in the URLs it builds', () => {
    const commands = installCommands({
      token,
      hostName: 'SQL01',
      hubAddress: 'hub.example.com:8443',
      publicUrl: 'https://dashboard.example.com/',
    });
    expect(commands.linux).not.toContain('.com//');
    expect(commands.windows).not.toContain('.com//');
  });
});
