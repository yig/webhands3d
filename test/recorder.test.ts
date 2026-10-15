import { writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ViewSource } from '../src/backends/multiview';
import { Recorder, recordedSamples } from '../src/debug/recorder';
import type { Intrinsics } from '../src/intrinsics';
import { calibrateStereo } from '../src/stereo/calibrate';
import type { HandFrameListener, Hand3D } from '../src/types';
import { TRUE_LENGTHS } from './sim';
import { BASELINE, K0, K1, simulateStereo } from './stereoSim';

class FakeSource implements ViewSource {
  handScale = 1;
  skeletons: ViewSource['skeletons'] = {};
  private listeners = new Set<HandFrameListener>();
  constructor(public intrinsics: Intrinsics, public cameraId: string, public label: string) {}
  async start() {}
  stop() {}
  onFrame(l: HandFrameListener) {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  emit(hands: Hand3D[], t: number) {
    for (const l of this.listeners) l(hands, t);
  }
}

describe('Recorder', () => {
  it('records every camera and replays to the same calibration', () => {
    const sources = [new FakeSource(K0, 'laptop', 'FaceTime'), new FakeSource(K1, 'remote:phone', 'iPhone')];
    sources[0].skeletons.Right = { lengths: TRUE_LENGTHS, palm: new Float64Array(15) };
    let clock = 0;
    const recorder = new Recorder({ sources, calibrations: [null, null] }, () => clock);
    recorder.start();
    const { samples0, samples1 } = simulateStereo({ offsetMs: 60 });
    const events = [
      ...samples0.map((h) => ({ view: 0, h, at: h.timestamp })),
      ...samples1.map((h) => ({ view: 1, h, at: h.timestamp + 60 + 120 })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) {
      clock = e.at;
      sources[e.view].emit([e.h], e.h.timestamp);
    }
    const rec = recorder.stop('calibrate', { note: 'simulated' });
    expect(rec.views.map((v) => v.label)).toEqual(['FaceTime', 'iPhone']);
    expect(rec.views[1].frames).toHaveLength(samples1.length);
    expect(rec.views[1].frames[5].at - rec.views[1].frames[5].t).toBeCloseTo(180, 6);
    expect(rec.views[0].skeletons.Right?.lengths).toHaveLength(20);

    // Through JSON, as a downloaded file would be.
    const json = JSON.stringify(rec);
    if (process.env.WEBHANDS_WRITE_SIM_RECORDING) writeFileSync(process.env.WEBHANDS_WRITE_SIM_RECORDING, json);
    const back = JSON.parse(json) as typeof rec;
    let s = 7;
    const random = () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
    const cal = calibrateStereo(
      {
        samples0: recordedSamples(back.views[0]),
        samples1: recordedSamples(back.views[1]),
        k0: back.views[0].intrinsics!,
        k1: back.views[1].intrinsics!,
        skeletonLengths: { Right: back.views[0].skeletons.Right!.lengths },
        handScale: 1,
      },
      { random },
    );
    expect(Math.abs(Math.hypot(...cal.t) / BASELINE - 1)).toBeLessThan(0.03);
    expect(Math.abs(cal.timeOffsetMs - 60)).toBeLessThanOrEqual(6);
  });
});
