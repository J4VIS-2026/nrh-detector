/**
 * 텐서 하나를 탐지 결과 하나로. **런타임을 모른다.**
 *
 * 세션은 인자로 받는다 - `run` 함수 하나만 있으면 되고, 그것이 `onnxruntime-web`인지
 * `onnxruntime-react-native`인지 여기서는 알 필요가 없다.
 *
 * **기준 구현과의 대조는 이 파일에 건다.** 두 진입점이 각자 세션만 다르게 만들어 여기로 들어오므로,
 * 여기가 기준 구현과 같으면 두 대상이 같다는 뜻이 된다.
 */

import type { LetterboxParams } from './letterbox.js';
import { DEFAULT_CONF, DEFAULT_IOU, postprocess } from './postprocess.js';
import type { ImageInfo, Settings, DetectionResult } from './schema.js';

/**
 * 세션이 해줘야 하는 일 전부.
 *
 * 진입점이 이것을 만들어 넘긴다.
 */
export interface Session {
  /**
   * 입력 텐서를 넣고 `output0`을 받는다.
   *
   * @returns 평탄화된 값과 그 모양 `[1, 채널수, 앵커수]`.
   */
  run(input: Float32Array, size: number): Promise<{ data: Float32Array; dims: readonly number[] }>;
  /** 뜻은 `schema.ts` 의 `Settings` 참고. */
  providers: string[];
  modelFile: string;
  modelName: string | null;
  /** 모델에서 읽은 클래스 맵. */
  classNames: Map<number, string>;
  /** 축소에 무엇을 썼는지 - `canvas`, `opencv` 등. 결과에 그대로 실린다. */
  resize: string;
}

export interface DetectOptions {
  conf?: number;
  iou?: number;
  /**
   * 이 프레임을 **받은 시각** (unix epoch 초).
   *
   * 안 주면 지금 시각을 쓴다. 프레임을 직접 읽어 넘기는 경우 그 사이에 흐른 시간만큼
   * 늦은 값이 되므로, **언제 손에 넣었는지 아는 쪽**이 넣어주는 것이 맞다.
   */
  receivedAt?: number;
  /** 스트림에서 왔다면 그 안 어디였는지. */
  stream?: ImageInfo['stream'];
}

/**
 * 이미 만들어진 입력 텐서로 탐지 하나를 낸다.
 *
 * @param tensor `(1, 3, 크기, 크기)`를 평탄화한 float32. 0-1 정규화, NCHW.
 * @param params 이 이미지의 레터박스 값. **전처리가 실제로 쓴 것**이어야 한다 - 원본
 *   크기에서 다시 계산하면 반올림이 달라져 박스가 밀린다.
 * @param preprocessMs 호출자가 잰 전처리 시간. 대상마다 하는 일이 달라 여기서 못 잰다.
 */
export async function detectFromTensor(
  session: Session,
  tensor: Float32Array,
  params: LetterboxParams,
  preprocessMs: number,
  options: DetectOptions = {},
): Promise<DetectionResult> {
  const conf = options.conf ?? DEFAULT_CONF;
  const iou = options.iou ?? DEFAULT_IOU;

  const t0 = performance.now();
  const { data, dims } = await session.run(tensor, params.inputSize);
  const t1 = performance.now();

  // 모양은 (1, 4+클래스수, 앵커수)다. 앞의 1은 배치다
  const channels = dims.length >= 3 ? dims[dims.length - 2] : 0;
  const anchors = dims.length >= 3 ? dims[dims.length - 1] : 0;
  const detections = postprocess(data, channels, anchors, params, session.classNames, conf, iou);
  const t2 = performance.now();

  const settings: Settings = {
    conf,
    iou,
    resize: session.resize,
    providers: [...session.providers],
    model: session.modelName,
    model_file: session.modelFile,
    // 이 값은 추적기가 정한다 - `schema.ts` 의 `Settings.track` 참고
    track: false,
  };

  return {
    speed: {
      preprocess: preprocessMs,
      inference: t1 - t0,
      postprocess: t2 - t1,
    },
    settings,
    image: {
      width: params.origWidth,
      height: params.origHeight,
      received_at: options.receivedAt ?? Date.now() / 1000,
      stream: options.stream ?? null,
    },
    detections,
  };
}
