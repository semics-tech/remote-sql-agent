/**
 * Worker minimum-version gate (§11 M5).
 *
 * An operator who finds a defect in a worker version needs a way to stop that
 * version talking to the control plane without visiting 50+ hosts. Setting
 * RSAGENT_MINIMUM_WORKER_VERSION refuses older workers at the door; each one
 * logs exactly why and keeps retrying, so upgrading the host is all that is
 * needed to bring it back.
 */

export interface VersionCheck {
  allowed: boolean;
  reason?: string;
}

/** Compare two dotted numeric versions. Pre-release suffixes are ignored. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string): number[] =>
    v
      .split('-')[0]!
      .split('.')
      .map((part) => Number.parseInt(part, 10))
      .map((n) => (Number.isFinite(n) ? n : 0));

  const left = parse(a);
  const right = parse(b);
  const length = Math.max(left.length, right.length);

  for (let i = 0; i < length; i++) {
    const l = left[i] ?? 0;
    const r = right[i] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

export function checkWorkerVersion(
  reportedVersion: string,
  minimumVersion: string | null,
): VersionCheck {
  if (!minimumVersion) return { allowed: true };

  if (!reportedVersion) {
    // A worker that will not say what it is cannot be assessed. Refuse rather
    // than assume it is current.
    return {
      allowed: false,
      reason: `This control plane requires worker version ${minimumVersion} or newer, and this worker did not report a version.`,
    };
  }

  if (compareVersions(reportedVersion, minimumVersion) < 0) {
    return {
      allowed: false,
      reason:
        `Worker version ${reportedVersion} is older than the minimum this control plane accepts ` +
        `(${minimumVersion}). Upgrade the worker on this host; it will reconnect on its own.`,
    };
  }

  return { allowed: true };
}
