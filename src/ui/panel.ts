import { MonocularHandTracker } from '../backends/monocular';
import { MultiViewHandTracker, type ViewSource } from '../backends/multiview';
import { KNOWN_LENGTHS, KNOWN_RECTANGLES } from '../calibration/objects';
import { Recorder, downloadRecording, type Recording } from '../debug/recorder';
import { fovFromIntrinsics } from '../intrinsics';
import { calibrateFromPattern, PATTERN_ADVICE, showCalibrationPattern } from './pattern';
import { pickRectangle } from './pickCorners';
import { CSS, el } from './style';

export type CalibrationPanelStep = 'lens' | 'handSize' | 'skeleton' | 'positions';
export type StatusKind = 'info' | 'busy' | 'ok' | 'error';

export interface CalibrationPanelOptions {
  /** A single-camera tracker, or a multi-camera tracker (its cameras are listed and kept up to date). */
  tracker: MonocularHandTracker | MultiViewHandTracker;
  /**
   * Steps to show. Default: one camera → lens, hand size, bone lengths;
   * several cameras → lens, hand size, camera positions (which also measure
   * the bone lengths).
   */
  steps?: CalibrationPanelStep[];
  /** The video element showing a camera (for clicking corners and pattern feedback). Default: the tracker's own video. */
  videoFor?: (source: ViewSource) => HTMLVideoElement | null;
  /** Name for a camera. Default: its label, else "Camera i". */
  nameFor?: (source: ViewSource, index: number) => string;
  /** Whether those videos are shown mirrored (selfie view); may depend on the camera. Default true. */
  mirrored?: boolean | ((source: ViewSource) => boolean);
  /** Offer "Show pattern for another camera" (shows the pattern on this screen). Default true. */
  showPatternButton?: boolean;
  /** Record calibration runs and offer them for download (for debugging). Default: true for several cameras. */
  recordings?: boolean;
  /** Show the status banner (fixed at the top of the window). Default true. */
  banner?: boolean;
  /** Called with every status message, e.g. to show it in your own UI. */
  onStatus?: (text: string, kind: StatusKind) => void;
}

export interface CalibrationPanel {
  /** The panel's host element (its content is in a shadow root). */
  readonly element: HTMLElement;
  /** Show a message in the panel's status banner. */
  say(text: string, kind?: StatusKind): void;
  /** Re-render (cameras added or removed, calibration changed elsewhere). It also refreshes itself every second. */
  refresh(): void;
  destroy(): void;
}

/**
 * A ready-made calibration UI for a tracker: guided steps with live status,
 * using the library's calibration functions (screen pattern, clicked
 * rectangles with edge snapping, hand size, camera positions). Renders into a
 * shadow root (so page CSS doesn't leak in) and can be themed with CSS custom
 * properties on the host element: --wh-bg, --wh-fg, --wh-muted, --wh-border,
 * --wh-accent, --wh-font.
 *
 * ```ts
 * const panel = createCalibrationPanel(document.querySelector('#calibration'), { tracker });
 * ```
 */
export function createCalibrationPanel(container: HTMLElement, options: CalibrationPanelOptions): CalibrationPanel {
  const { tracker } = options;
  const multi = tracker instanceof MultiViewHandTracker;
  const steps = options.steps ?? (multi ? ['lens', 'handSize', 'positions'] : ['lens', 'handSize', 'skeleton']);
  const mirroredOf = (s: ViewSource) =>
    typeof options.mirrored === 'function' ? options.mirrored(s) : options.mirrored ?? true;
  const recordings = options.recordings ?? multi;
  const host = document.createElement('div');
  host.className = 'webhands-calibration';
  container.append(host);
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `<style>${CSS}</style><div class="banner" role="status" aria-live="polite"></div><div class="panel"></div>`;
  const banner = root.querySelector<HTMLDivElement>('.banner')!;
  const panel = root.querySelector<HTMLDivElement>('.panel')!;
  if (options.banner === false) banner.remove();

  const say = (text: string, kind: StatusKind = 'info') => {
    banner.textContent = text;
    banner.dataset.kind = kind;
    options.onStatus?.(text, kind);
  };
  const sources = (): ViewSource[] => (multi ? tracker.sources : [tracker]);
  const nameOf = (s: ViewSource, i: number) =>
    options.nameFor?.(s, i) || (s as { label?: string }).label || `Camera ${i + 1}`;
  const videoOf = (s: ViewSource) =>
    options.videoFor?.(s) ?? (s instanceof MonocularHandTracker ? s.videoElement : null);
  /** Whether a camera's lens is calibrated: here, or on its own device (a phone reports it). */
  const lensCalibrated = (s: ViewSource) => !!s.calibrator?.status.focal.calibrated || !!s.focalCalibrated;
  const errorText = (e: unknown) =>
    e instanceof DOMException && e.name === 'AbortError' ? 'Cancelled' : e instanceof Error ? e.message : String(e);

  /** A button that runs a step, showing progress in the banner; long steps can be stopped. */
  const button = (label: string, run: (signal: AbortSignal) => Promise<string>, opts: { primary?: boolean; stoppable?: boolean } = {}) => {
    const b = el('button', { class: opts.primary ? 'primary' : '' }, label) as HTMLButtonElement;
    let controller: AbortController | null = null;
    b.addEventListener('click', async () => {
      if (controller) {
        if (opts.stoppable) controller.abort();
        return;
      }
      controller = new AbortController();
      if (opts.stoppable) {
        b.textContent = 'Stop';
        b.classList.add('running');
      } else b.disabled = true;
      try {
        say(await run(controller.signal), 'ok');
      } catch (e) {
        say(errorText(e), 'error');
      } finally {
        controller = null;
        b.textContent = label;
        b.classList.remove('running');
        b.disabled = false;
        render();
      }
    });
    return b;
  };

  let lastRecording: Recording | null = null;

  // ---------- sections ----------
  const lensSection = () => {
    const rows = sources().map((s, i) => {
      const cal = s.calibrator;
      const k = s.intrinsics;
      const status = cal && { calibrated: lensCalibrated(s) };
      const name = nameOf(s, i);
      const video = videoOf(s);
      const fov = k ? `${fovFromIntrinsics(k).toFixed(1)}°` : '—';
      const row = el('div', { class: 'row' },
        el('div', { class: 'name' }, name),
        el('span', { class: `chip ${status?.calibrated ? 'done' : 'todo'}` }, status?.calibrated ? `FOV ${fov} ✓` : `FOV ${fov} (default)`),
      );
      if (!cal || !k) {
        row.append(el('div', { class: 'hint' }, 'Start this camera first.'));
        return row;
      }
      const mirrored = mirroredOf(s);
      if (!video) {
        row.append(el('div', { class: 'hint' }, 'Calibrate this camera on its own device (e.g. "Calibrate from screen" on the phone).'));
        return row;
      }
      const object = el('select', { title: 'Object to click' },
        ...['card', 'a4', 'letter'].map((id) => {
          const o = KNOWN_RECTANGLES.find((r) => r.id === id)!;
          return el('option', { value: id }, id === 'card' ? 'Credit card' : o.label.replace(/ \(.*/, ''));
        }),
      ) as HTMLSelectElement;
      const fovInput = el('input', { type: 'number', step: '0.5', min: '20', max: '140', value: fovFromIntrinsics(k).toFixed(1), title: 'Horizontal field of view, degrees' }) as HTMLInputElement;
      fovInput.addEventListener('change', () => {
        const v = parseFloat(fovInput.value);
        if (v > 0) {
          cal.setFieldOfView(v);
          say(`${name}: field of view set to ${v}°`, 'ok');
          render();
        }
      });
      row.append(
        el('div', { class: 'actions' },
          button('Screen pattern', async (signal) => {
            const f = await calibrateFromPattern(video, cal, () => s.intrinsics, {
              signal,
              feedback: { mirrored },
              onProgress: ({ views, needed, state }) => say(`${name}: ${PATTERN_ADVICE[state]} · ${views} of ${needed} views`, 'busy'),
            });
            return `${name}: focal length ${f.toFixed(0)} px (FOV ${fovFromIntrinsics(s.intrinsics!).toFixed(1)}°) from the screen pattern`;
          }, { primary: true, stoppable: true }),
          el('span', { class: 'or' }, 'or'),
          object,
          button('Click corners', async () => {
            say(`${name}: click near the 4 corners in order around the edge — they snap to the edges`, 'busy');
            const { corners, snapped } = await pickRectangle(video, { mirrored });
            const f = cal.addRectangleView(corners, object.value);
            return `${name}: focal length ${f.toFixed(0)} px${snapped ? '' : ' (edges not found; used your clicks)'}. Add a few more views.`;
          }),
          el('span', { class: 'or' }, 'or FOV'),
          fovInput,
        ),
      );
      return row;
    });
    return section(
      'Camera lens (field of view)',
      sources().length > 0 && sources().every(lensCalibrated),
      'Easiest: on another device (phone, laptop) press "Show pattern for another camera", press "Screen pattern" here, and hold that screen up to this camera, tilting it 30–60° in different directions. Or hold a credit card (or paper flat on a book) tilted and click its corners. This measures the lens only, so cameras can be moved afterwards.',
      ...rows,
      options.showPatternButton === false
        ? null
        : el('div', { class: 'actions' },
            button('Show pattern for another camera', async () => {
              showCalibrationPattern({ message: 'Point the other camera here · tap or Esc to close' });
              return 'Showing the pattern (tap or Esc to close)';
            }),
          ),
    );
  };

  const handSizeSection = () => {
    const first = sources()[0];
    const cal = first?.calibrator;
    const done = !!cal?.status.handSize.calibrated;
    const object = el('select', {}, ...KNOWN_LENGTHS.map((o) => el('option', { value: o.id }, o.label))) as HTMLSelectElement;
    const length = el('input', { type: 'number', step: '0.1', value: '18.5', title: 'Wrist crease to middle fingertip, cm' }) as HTMLInputElement;
    return section(
      'Hand size (real-world scale)',
      done,
      `Hold the object by its two ends between thumb tip and index fingertip, facing ${first ? nameOf(first, 0) : 'the camera'}. Without this, distances assume an average hand.`,
      el('div', { class: 'row' },
        el('span', { class: `chip ${done ? 'done' : 'todo'}` }, done ? `scale ${cal!.status.handSize.scale.toFixed(3)} ✓` : 'not calibrated'),
        cal
          ? el('div', { class: 'actions' },
              object,
              button('Measure', async (signal) => {
                say('Hold still with the object between thumb and index fingertip…', 'busy');
                return `Hand scale ${(await cal.handSizeFromObject(object.value, { signal })).toFixed(3)}`;
              }, { primary: !done }),
              el('span', { class: 'or' }, 'or hand length (cm)'),
              length,
              button('Use length', async (signal) => {
                say('Hold one open hand, fingers together, facing the camera…', 'busy');
                return `Hand scale ${(await cal.handSizeFromLength(parseFloat(length.value) / 100, { signal })).toFixed(3)}`;
              }),
            )
          : null,
      ),
    );
  };

  const skeletonSection = () => {
    const cal = sources()[0]?.calibrator;
    const st = cal?.status.skeleton;
    const sides = st ? (['Left', 'Right'] as const).filter((s) => st[s]) : [];
    return section(
      'Bone lengths',
      sides.length > 0,
      'Show both hands, fingers spread, and slowly turn them in every direction for 8 s (after the hand size).',
      el('div', { class: 'row' },
        el('span', { class: `chip ${sides.length ? 'done' : 'todo'}` }, sides.length ? `${sides.join(' + ')} ✓` : 'not measured'),
        cal
          ? el('div', { class: 'actions' },
              button('Measure bone lengths (8 s)', async (signal) => {
                await cal.skeleton({
                  signal,
                  onProgress: ({ elapsedMs, durationMs, frames }) =>
                    say(`Turn both hands slowly… ${Math.ceil((durationMs - elapsedMs) / 1000)} s (left ${frames.Left}, right ${frames.Right} frames)`, 'busy'),
                });
                return 'Bone lengths measured';
              }, { primary: sides.length === 0, stoppable: true }),
            )
          : null,
      ),
    );
  };

  const positionsSection = () => {
    if (!multi) return null;
    const st = tracker.status;
    const others = st.views.slice(1);
    const done = others.length > 0 && others.every((v) => v.calibrated);
    const rows = others.map((v) => {
      const c = v.calibration;
      const name = nameOf(tracker.sources[v.index], v.index);
      return el('div', { class: 'row' },
        el('div', { class: 'name' }, name),
        el('span', { class: `chip ${c ? (c.warning ? 'warn' : 'done') : 'todo'}` },
          c ? `${(Math.hypot(...c.t) * 100).toFixed(0)} cm from ${nameOf(tracker.sources[0], 0)} · ${(c.inlierRatio * 100).toFixed(0)} % consistent` : 'not calibrated'),
        c?.warning ? el('div', { class: 'hint warn' }, c.warning) : null,
      );
    });
    return section(
      'Camera positions',
      done,
      others.length
        ? 'Hold up one open hand where the cameras see it (other hand out of view) and move it slowly through the whole shared space for 12 s: near and far, side to side, turning it. Redo this whenever a camera moves. Also measures your bone lengths.'
        : 'Add a second camera to calibrate camera positions.',
      ...rows,
      others.length
        ? el('div', { class: 'actions' },
            button('Calibrate cameras (12 s)', async (signal) => {
              const recorder = recordings ? new Recorder(tracker) : null;
              recorder?.start();
              let result: Awaited<ReturnType<MultiViewHandTracker['calibrate']>> | undefined;
              let error: unknown;
              try {
                result = await tracker.calibrate({
                  signal,
                  onProgress: ({ elapsedMs, durationMs, frames }) =>
                    say(`Move one hand through the shared view… ${Math.ceil((durationMs - elapsedMs) / 1000)} s (hand frames per camera: ${frames.join(' / ')})`, 'busy'),
                });
              } catch (e) {
                error = e;
                throw e;
              } finally {
                if (recorder) lastRecording = recorder.stop('calibrate', result ? { views: result.views } : { error });
              }
              const failures = result.views.flatMap((r, i) => (r instanceof Error ? [`${nameOf(tracker.sources[i], i)}: ${r.message}`] : []));
              if (failures.length) throw new Error(failures.join('; '));
              const warnings = result.views.flatMap((r) => (r && !(r instanceof Error) && r.warning ? [r.warning] : []));
              return warnings.length ? `Calibrated, but: ${warnings[0]}` : 'Cameras calibrated';
            }, { primary: !done, stoppable: true }),
            button('Reset positions', async () => {
              tracker.resetCalibration();
              return 'Camera positions reset';
            }),
          )
        : null,
      recordings
        ? el('details', {},
            el('summary', {}, 'Debugging'),
            el('div', { class: 'hint' }, "Recordings contain each camera's hand landmarks, timing and calibration (no images)."),
            el('div', { class: 'actions' },
              lastRecording
                ? button('Download last calibration recording', async () => {
                    downloadRecording(lastRecording!);
                    return 'Recording downloaded';
                  })
                : null,
              button('Record 10 s', async (signal) => {
                const recorder = new Recorder(tracker);
                recorder.start();
                await new Promise<void>((resolve, reject) => {
                  const timer = setTimeout(resolve, 10000);
                  signal.addEventListener('abort', () => {
                    clearTimeout(timer);
                    reject(new DOMException('Recording cancelled', 'AbortError'));
                  });
                });
                downloadRecording(recorder.stop('tracking'));
                return 'Recording downloaded';
              }, { stoppable: true }),
            ),
          )
        : null,
    );
  };

  const resetSection = () =>
    el('div', { class: 'actions reset' },
      button('Reset all calibration', async () => {
        for (const s of sources()) s.calibrator?.reset();
        if (multi) tracker.resetCalibration();
        return 'Calibration reset';
      }),
    );

  // ---------- rendering ----------
  let lastKey = '';
  const render = () => {
    // Don't rebuild while the user is typing in or choosing from a control.
    const active = root.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'SELECT')) return;
    const parts = steps.map((step) =>
      step === 'lens' ? lensSection() : step === 'handSize' ? handSizeSection() : step === 'skeleton' ? skeletonSection() : positionsSection(),
    );
    panel.replaceChildren(...parts.filter((p): p is HTMLElement => !!p), resetSection());
  };
  const changeKey = () =>
    JSON.stringify([
      sources().map((s) => [s.cameraId, s.intrinsics?.fx, s.calibrator?.status, s.focalCalibrated, (s as { label?: string }).label]),
      multi ? tracker.status.views.map((v) => [v.calibration?.R, v.calibration?.warning]) : null,
      !!lastRecording,
    ]);
  const tick = () => {
    // Re-render only when something changed and no step is running (running buttons hold state).
    if (root.querySelector('button.running, button:disabled')) return;
    const key = changeKey();
    if (key !== lastKey) {
      lastKey = key;
      render();
    }
  };
  const timer = setInterval(tick, 1000);
  tick();

  return {
    element: host,
    say,
    refresh: () => {
      lastKey = '';
      tick();
    },
    destroy: () => {
      clearInterval(timer);
      host.remove();
    },
  };
}

// ---------- helpers ----------
function section(title: string, done: boolean, hint: string, ...content: (HTMLElement | null)[]): HTMLElement {
  return el('section', { class: done ? 'done' : '' },
    el('h3', {}, el('span', { class: 'mark' }, done ? '✓' : '○'), title),
    el('p', { class: 'hint' }, hint),
    ...content,
  );
}
