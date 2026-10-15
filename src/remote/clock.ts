/**
 * Estimates the offset between a remote clock and ours from ping/pong round
 * trips (NTP-style): offset = remote − local, from the round trip with the
 * smallest delay among recent ones (its midpoint is the most certain).
 */
export class ClockSync {
  private samples: { rtt: number; offset: number }[] = [];

  constructor(private readonly keep = 20) {}

  /** t0: our send time, t1: remote reply time, t2: our receive time. */
  add(t0: number, t1: number, t2: number): void {
    const rtt = t2 - t0;
    if (rtt < 0) return;
    this.samples.push({ rtt, offset: t1 - (t0 + t2) / 2 });
    if (this.samples.length > this.keep) this.samples.shift();
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  /** remote − local, ms (0 until the first round trip). */
  get offset(): number {
    let best = this.samples[0];
    for (const s of this.samples) if (s.rtt < best.rtt) best = s;
    return best?.offset ?? 0;
  }

  /** Smallest recent round-trip time, ms (uncertainty of the offset is about half). */
  get rtt(): number {
    return this.samples.reduce((m, s) => Math.min(m, s.rtt), Infinity);
  }

  toLocal(remoteTime: number): number {
    return remoteTime - this.offset;
  }
}
