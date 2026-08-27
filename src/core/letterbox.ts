/**
 * 레터박스 파라미터 계산.
 *
 * **픽셀을 건드리지 않는다.** 스케일과 패딩이 얼마인지만 구한다. 실제로 줄이고 채우는
 * 것은 대상마다 다르므로(브라우저는 canvas, RN은 opencv) 진입점 몫이다.
 *
 * 나눈 이유는 **이 계산이 박스가 밀리는 버그의 서식지**이기 때문이다. 여기만 따로
 * 검증할 수 있어야 리샘플러 차이와 섞이지 않는다.
 */

import { bankersRound } from './rounding.js';

/** 모델 입력 한 변. */
export const INPUT_SIZE = 640;

/** 여백을 채울 회색 값. */
export const PAD_VALUE = 114;

/**
 * 640 좌표계의 박스를 원본 이미지로 되돌리는 데 필요한 값 전부.
 *
 * 후처리는 **여기서 실제로 쓴 값**이 필요하다. 원본 크기에서 다시 계산하면 반올림이
 * 달라져 박스가 몇 픽셀씩 밀린다. 이 값을 들고 다니는 이유가 그것이다.
 */
export interface LetterboxParams {
  /** 원본 이미지에 곱한 배율. */
  scale: number;
  /** 왼쪽에 덧붙인 여백 픽셀 수. */
  padX: number;
  /** 위쪽에 덧붙인 여백 픽셀 수. */
  padY: number;
  newWidth: number;
  newHeight: number;
  origWidth: number;
  origHeight: number;
  /** 정사각 입력 한 변. */
  inputSize: number;
}

/**
 * 원본 크기에서 레터박스 값을 구한다.
 *
 * 기준 구현의 레터박스와 **같은 값이 나와야 한다.** 두 군데가 미묘하다.
 *
 * - `round()`가 은행가 반올림이다 (`rounding.ts` 참고).
 * - 여백을 반으로 나눌 때 **0.1을 뺀다.** 정확히 .5인 경우를 은행가 반올림에 맡기지
 *   않고 한 방향으로 고정하려는 것이다. 빼먹으면 짝수/홀수에 따라 박스가 1px 갈린다.
 */
export function letterbox(
  origWidth: number,
  origHeight: number,
  inputSize: number = INPUT_SIZE,
): LetterboxParams {
  const scale = Math.min(inputSize / origHeight, inputSize / origWidth);

  const newWidth = bankersRound(origWidth * scale);
  const newHeight = bankersRound(origHeight * scale);

  const spareX = (inputSize - newWidth) / 2;
  const spareY = (inputSize - newHeight) / 2;
  const padX = bankersRound(spareX - 0.1);
  const padY = bankersRound(spareY - 0.1);

  return { scale, padX, padY, newWidth, newHeight, origWidth, origHeight, inputSize };
}
