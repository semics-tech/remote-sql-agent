import { describe, expect, it } from 'vitest';
import { describeBaseline, describeEta } from '../src/pages/Overview.js';
import { liveElapsedSeconds } from '../src/ticker.js';

/**
 * The running-jobs arithmetic.
 *
 * Everything here feeds a number an operator uses to decide whether to
 * intervene, so being confidently wrong is worse than saying nothing — hence
 * the cases about withholding an estimate rather than inventing one.
 */

describe('liveElapsedSeconds', () => {
  const FETCHED_AT = 1_800_000_000_000;

  it('is the server figure at the moment the response arrived', () => {
    expect(liveElapsedSeconds(42, FETCHED_AT, FETCHED_AT)).toBe(42);
  });

  it('counts forward from there', () => {
    expect(liveElapsedSeconds(42, FETCHED_AT, FETCHED_AT + 3_000)).toBe(45);
    expect(liveElapsedSeconds(42, FETCHED_AT, FETCHED_AT + 60_000)).toBe(102);
  });

  it('ignores any disagreement between the browser clock and the server', () => {
    // The point of anchoring on the fetch: only the local clock measures the
    // delta, so a machine minutes out of step still reports the right elapsed.
    const skewed = liveElapsedSeconds(42, FETCHED_AT, FETCHED_AT + 5_000);
    expect(skewed).toBe(47);
  });

  it('never runs backwards', () => {
    // A response can land a millisecond "in the future" against the local clock.
    expect(liveElapsedSeconds(42, FETCHED_AT + 500, FETCHED_AT)).toBe(42);
  });

  it('has nothing to report without a server measurement', () => {
    expect(liveElapsedSeconds(null, FETCHED_AT, FETCHED_AT + 1_000)).toBeNull();
  });
});

describe('describeEta', () => {
  it('counts down while the run is inside its average', () => {
    expect(describeEta(30, 120)).toEqual({ label: '00:01:30 left', state: 'ok' });
  });

  it('turns into an overrun once the average is passed', () => {
    // Not "0s left" held at zero: a late run is the thing worth reading here.
    expect(describeEta(150, 120)).toEqual({ label: 'over by 00:00:30', state: 'near' });
  });

  it('escalates at twice the average, matching the overrun test on the server', () => {
    expect(describeEta(239, 120)!.state).toBe('near');
    expect(describeEta(240, 120)!.state).toBe('over');
  });

  it('withholds an estimate rather than inventing one', () => {
    expect(describeEta(30, null)).toBeNull();
    expect(describeEta(null, 120)).toBeNull();
    // A zero average would divide the progress bar by zero and estimate nothing.
    expect(describeEta(30, 0)).toBeNull();
  });

  it('rounds the average before comparing, so the label cannot disagree with itself', () => {
    // 120.4s average, 120s elapsed: "left" must not claim a duration of 00:00:00.
    expect(describeEta(120, 120.4)).toEqual({ label: 'over by 00:00:00', state: 'near' });
  });
});

describe('describeBaseline', () => {
  it('gives both figures when both are known', () => {
    expect(describeBaseline(130, 124)).toBe(
      'Usually 00:02:10 · last run 00:02:04. Averaged over successful runs in the last 30 days.',
    );
  });

  it('says why there is no average when there are too few runs', () => {
    expect(describeBaseline(null, 124)).toBe(
      'last run 00:02:04. Too few successful runs for an average.',
    );
  });

  it('admits to knowing nothing rather than showing an empty tooltip', () => {
    expect(describeBaseline(null, null)).toBe(
      'No successful run on record to compare this against.',
    );
  });
});
