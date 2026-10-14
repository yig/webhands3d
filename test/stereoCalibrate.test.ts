import { describe, expect, it } from 'vitest';
import { calibrateStereo } from '../src/stereo/calibrate';
import { rng, TRUE_LENGTHS } from './sim';
import { BASELINE, K0, K1, R01, rotationError, simulateStereo, T01 } from './stereoSim';

const random = (() => {
  const r = rng(99);
  return () => (r() + 1) / 2;
})();

describe('calibrateStereo', () => {
  it('recovers the time offset, relative pose and metric baseline from a moving hand', () => {
    const { samples0, samples1 } = simulateStereo({ offsetMs: 60 });
    const cal = calibrateStereo(
      { samples0, samples1, k0: K0, k1: K1, skeletonLengths: { Right: TRUE_LENGTHS }, handScale: 1 },
      { random },
    );
    console.log(
      `offset ${cal.timeOffsetMs} ms, rot err ${((rotationError(cal.R, R01) * 180) / Math.PI).toFixed(2)}°, ` +
        `baseline ${(Math.hypot(...cal.t) * 100).toFixed(1)} cm (true ${(BASELINE * 100).toFixed(1)}), rms ${cal.rmsPx.toFixed(2)} px`,
    );
    expect(Math.abs(cal.timeOffsetMs - 60)).toBeLessThanOrEqual(6);
    expect(rotationError(cal.R, R01)).toBeLessThan((1 * Math.PI) / 180);
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.03);
    const dir = (cal.t[0] * T01[0] + cal.t[1] * T01[1] + cal.t[2] * T01[2]) / (Math.hypot(...cal.t) * BASELINE);
    expect(dir).toBeGreaterThan(0.995);
    expect(cal.scaleFrom).toBe('skeleton');
  });

  it('falls back to hand size for scale when no skeleton is calibrated', () => {
    const { samples0, samples1 } = simulateStereo({ offsetMs: 0, seed: 3 });
    const cal = calibrateStereo({ samples0, samples1, k0: K0, k1: K1, handScale: 1 }, { random });
    expect(cal.scaleFrom).toBe('handSize');
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.08);
  });
});
