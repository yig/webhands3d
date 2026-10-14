/**
 * Two cameras are the N = 2 case of the multi-view tracker; these names are kept
 * for convenience.
 */
export {
  MultiViewHandTracker as StereoHandTracker,
  toCamera0,
  type MultiViewOptions as StereoOptions,
  type ViewSource as StereoSource,
} from './multiview';
