/**
 * 출력 계약.
 *
 * **이 파일이 남들과의 약속이다.** 기준 구현과 같은 구조여야 하고, 한번 넘긴
 * 뒤에는 못 바꾼다. 내부 구현(전처리 속도, 보정 방식)은 나중에 얼마든지 고쳐도 되지만
 * 여기는 아니다.
 *
 * 두 규칙은 호출자에게 맡기지 않고 안에서 강제한다.
 *
 * - `width`/`height`는 **반올림된 좌표에서 파생**되므로 박스와 크기가 어긋날 수 없다.
 * - `detections`는 confidence 내림차순으로 정렬된다.
 */

import { bankersRound } from './rounding.js';

/** confidence를 직렬화할 때 남길 소수 자리. */
export const CONFIDENCE_DECIMALS = 3;

/** 단계별 소요 시간, 단위는 밀리초. */
export interface Speed {
  preprocess: number;
  inference: number;
  postprocess: number;
}

/**
 * 이 결과를 만들어낸 추론 설정.
 *
 * **결과와 함께 다녀야** 파일만 받은 쪽에서도 무엇으로 만든 결과인지 알 수 있다.
 * 모델을 두 필드로 담는 이유는, 이름만으로는 부족하기 때문이다 - 두 사람이 각자 자기
 * 모델을 `v2`라고 부르면 같은 문자열이 다른 모델을 가리킨다.
 */
export interface Settings {
  conf: number;
  iou: number;
  /** 축소에 무엇을 썼는지. 대상마다 다르다 - `canvas`, `opencv` 등. */
  resize: string;
  /** **실제로 활성화된** 프로바이더. 요청한 값이 아니라 세션이 보고하는 값이다. */
  providers: string[];
  /** 모델을 어떻게 불렀는지. 경로로 직접 열었으면 `null`. */
  model: string | null;
  /** 실제로 열린 모델 **파일 이름**. 폴더 경로는 넣지 않는다. */
  model_file: string;
  /** 추적을 거쳤는지. **이 값은 추적기가 정한다** - 탐지기는 항상 `false`로 내보낸다. */
  track: boolean;
}

/** 이 그림이 스트림 어디에서 왔는지. 이미지 한 장이면 `null`이다. */
export interface StreamInfo {
  /** **원본** 스트림의 몇 번째 프레임인가. 건너뛰면 번호도 건너뛴다. */
  frame_index: number;
  /** 스트림 시작으로부터 몇 밀리초인가. **카메라는 항상 `null`이다.** */
  timestamp_ms: number | null;
}

/**
 * 넣은 그림에 대한 것 - 크기, 언제 받았나, 스트림 어디서 왔나.
 *
 * 크기가 640이 아니라 **원본**인 것처럼, 나머지도 우리가 받은 그림 기준이다.
 */
export interface ImageInfo {
  width: number;
  height: number;
  /**
   * **우리가 이 그림을 받은 시각** (unix epoch 초). 항상 있다.
   *
   * 촬영 시각이 아니다 - 센서에서 오는 시간은 우리 바깥이다. 카메라에서는
   * `stream.timestamp_ms`가 늘 `null`이라, 시간 축이 필요하면 이 값을 쓴다.
   */
  received_at: number;
  stream: StreamInfo | null;
}

/**
 * 탐지된 객체 하나. 좌표계는 **원본 이미지** 기준이다.
 *
 * 좌표는 이미 반올림된 정수다. 반올림 책임은 후처리에 있다.
 */
export interface Detection {
  class_id: number;
  class_name: string;
  /** 객체에서는 원래 정밀도를 유지한다. 반올림은 직렬화할 때만 한다. */
  confidence: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  width: number;
  height: number;
  /**
   * 프레임을 넘나드는 객체 ID. 추적을 쓰지 않았으면 `null`이다.
   *
   * **키는 항상 있고 값만 달라진다.** 추적 여부에 따라 스키마가 바뀌면 받는 쪽이 두
   * 모양을 다뤄야 한다.
   */
  track_id: number | null;
}

export interface DetectionResult {
  speed: Speed;
  settings: Settings;
  image: ImageInfo;
  /** confidence 내림차순. */
  detections: Detection[];
}

/**
 * 좌표에서 `width`/`height`를 파생시켜 탐지 하나를 만든다.
 *
 * **직접 객체 리터럴로 만들지 마라.** 크기를 따로 넣으면 박스와 어긋날 수 있는데,
 * 그런 결과는 받는 쪽에서 검증할 방법이 없다.
 */
export function makeDetection(v: Omit<Detection, 'width' | 'height'>): Detection {
  return { ...v, width: v.x2 - v.x1, height: v.y2 - v.y1 };
}

/**
 * JSON으로 내보낼 모양으로 바꾼다.
 *
 * confidence는 **여기서만** 반올림한다. 객체가 원래 정밀도를 지니고 있어야 두 점수가
 * 같은 값으로 반올림돼도 정렬 순서가 유지된다.
 */
export function serializeResult(result: DetectionResult): Record<string, unknown> {
  const unit = 10 ** CONFIDENCE_DECIMALS;
  return {
    speed: { ...result.speed },
    settings: { ...result.settings, providers: [...result.settings.providers] },
    image: {
      ...result.image,
      stream: result.image.stream === null ? null : { ...result.image.stream },
    },
    detections: result.detections.map((d) => ({
      class_name: d.class_name,
      class_id: d.class_id,
      // 여기서도 은행가 반올림이다. 파이썬 `round(x, 3)`이 그렇게 동작한다.
      // `Math.round`를 쓰면 0.1235가 파이썬 0.123, JS 0.124로 갈린다
      confidence: bankersRound(d.confidence * unit) / unit,
      x1: d.x1,
      y1: d.y1,
      x2: d.x2,
      y2: d.y2,
      width: d.width,
      height: d.height,
      track_id: d.track_id,
    })),
  };
}
