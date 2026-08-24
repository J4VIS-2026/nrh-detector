/**
 * 파이썬과 같은 반올림.
 *
 * **`Math.round`를 쓰면 안 된다.** 파이썬 `round()`와 numpy `rint()`는 정확히 .5인 값을
 * **짝수 쪽으로** 보내는데(은행가 반올림), `Math.round`는 항상 위로 보낸다.
 *
 *     파이썬  round(638.5) = 638      JS  Math.round(638.5) = 639
 *     파이썬  round(639.5) = 640      JS  Math.round(639.5) = 640
 *
 * 실제로 얼마나 갈리나 재봤더니 **높이 1280 이미지에서 좌표의 25%가 어긋났다.** 박스가
 * 1px씩 밀리는 형태라 예외도 안 나고 화면으로도 구분이 안 된다.
 *
 * 레터박스 계산과 최종 좌표 반올림 **양쪽 모두** 이것을 쓴다.
 */
export function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const frac = value - floor;
  let result: number;
  if (frac > 0.5) result = floor + 1;
  else if (frac < 0.5) result = floor;
  // 정확히 .5 - 짝수 쪽으로 보낸다
  else result = floor % 2 === 0 ? floor : floor + 1;

  // **음수 0을 없앤다.** JS에는 `-0`이 있어서 `Math.floor(-0)`이 `-0`을 돌려준다.
  // 좌표로서는 0과 같은 값이지만 `Object.is`나 엄격 비교에서 갈리고, 대조 테스트가
  // 실패하는 형태로만 드러난다. `-0 === 0`이 참이므로 이 한 줄로 정리된다
  return result === 0 ? 0 : result;
}
