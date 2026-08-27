/**
 * 핵심 - 런타임을 모른다.
 *
 * 여기 있는 것은 **텐서를 받아 탐지를 돌려주는 계산**뿐이다. 세션을 만들거나 모델을
 * 싣는 것은 진입점 몫이다 (`nrh-detector/web`, `nrh-detector/native`).
 *
 * 그렇게 나눈 이유는 ONNX Runtime이 대상마다 다른 패키지이기 때문이다 - 버전도
 * 다르고(1.27 대 1.24) 로딩 방식도 다르다. **핵심이 런타임을 모르면 같은 계산을 두 번
 * 짜지 않아도 되고, 기준 구현과의 대조도 핵심에만 걸면 된다.**
 */

export { bankersRound } from './rounding.js';
export { INPUT_SIZE, PAD_VALUE, letterbox, type LetterboxParams } from './letterbox.js';
export {
  CONFIDENCE_DECIMALS,
  makeDetection,
  serializeResult,
  type Speed,
  type Settings,
  type StreamInfo,
  type ImageInfo,
  type Detection,
  type DetectionResult,
} from './schema.js';
export {
  DEFAULT_CONF,
  DEFAULT_IOU,
  postprocess,
  nms,
  classWiseNms,
  toOriginalCoords,
} from './postprocess.js';
export {
  NrhDetectorModelError,
  readMetadata,
  parseClassMap,
  readClassMap,
  readInputSize,
} from './classmap.js';
export { rgbaToTensor, rgbToTensor } from './tensor.js';
export { detectFromTensor, type Session, type DetectOptions } from './detect.js';
export { Tracker, DEFAULT_TRACK_PARAMS, type TrackParams, type GmcFn } from './tracker.js';
export { iouDistance, linearAssignment, fuseScore, type Box } from './assign.js';
export {
  Gmc,
  DEFAULT_GMC_OPTIONS,
  IDENTITY_WARP,
  rgbaToGray,
  downscaleGray,
  goodFeaturesToTrack,
  calcOpticalFlowPyrLK,
  solveSimilarity,
  estimateSimilarityRansac,
  type GmcOptions,
  type Corner,
} from './gmc.js';
