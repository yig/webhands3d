import { describe, expect, it } from 'vitest';
import { calibrateStereo } from '../src/stereo/calibrate';
import { defaultIntrinsics, intrinsicsFromFov } from '../src/intrinsics';
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

  it('calibrates against a slow camera (10 fps, like a phone running MediaPipe)', () => {
    const { samples0, samples1 } = simulateStereo({ offsetMs: 120, fps1: 10, seed: 11 });
    const cal = calibrateStereo(
      { samples0, samples1, k0: K0, k1: K1, skeletonLengths: { Right: TRUE_LENGTHS }, handScale: 1 },
      { random },
    );
    expect(Math.abs(cal.timeOffsetMs - 120)).toBeLessThanOrEqual(8);
    expect(rotationError(cal.R, R01)).toBeLessThan((1 * Math.PI) / 180);
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.03);
  });

  // Like a real recording: MediaPipe's 2D landmarks disagree between views by
  // several pixels, its 3D orientation wobbles by ~20°, 10 % of frames are
  // garbage, and the phone runs at 22 fps in portrait.
  const trueK0 = intrinsicsFromFov(1280, 720, 70);
  const trueK1 = intrinsicsFromFov(720, 1280, 45);
  const realistic = () =>
    simulateStereo({ offsetMs: 70, fps1: 22, noisePx: 6, worldRotationNoise: 0.35, outlierFrames: 0.1, k0: trueK0, k1: trueK1, seed: 21 });

  it('copes with realistic landmark noise and garbage frames', () => {
    const { samples0, samples1 } = realistic();
    const cal = calibrateStereo(
      { samples0, samples1, k0: trueK0, k1: trueK1, skeletonLengths: { Right: TRUE_LENGTHS }, handScale: 1 },
      { random },
    );
    expect(rotationError(cal.R, R01)).toBeLessThan((1.5 * Math.PI) / 180);
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.05);
    expect(Math.abs(cal.timeOffsetMs - 70)).toBeLessThanOrEqual(10);
    expect(cal.warning).toBeUndefined();
  });

  it('stays close with the default fields of view (66° across the long side)', () => {
    const { samples0, samples1 } = realistic();
    const cal = calibrateStereo(
      {
        samples0, samples1,
        k0: defaultIntrinsics(1280, 720), // 66° (true 70°)
        k1: defaultIntrinsics(720, 1280), // 40° across the width (true 45°)
        skeletonLengths: { Right: TRUE_LENGTHS },
        handScale: 1,
      },
      { random },
    );
    expect(rotationError(cal.R, R01)).toBeLessThan((4 * Math.PI) / 180);
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.15);
  });

  it('falls back to hand size for scale when no skeleton is calibrated', () => {
    const { samples0, samples1 } = simulateStereo({ offsetMs: 0, seed: 3 });
    const cal = calibrateStereo({ samples0, samples1, k0: K0, k1: K1, handScale: 1 }, { random });
    expect(cal.scaleFrom).toBe('handSize');
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.08);
  });
});
