// 소재 그림·타깃·전구체 이미지를 화면에 내보내는 유일한 지점.
//
// 왜 getImage(webp, quality 88/90) 를 쓰지 않는가:
//   손실 재압축을 한 번 더 거치면 순빨강·순파랑 곡선이 어두운 색으로 번지고(실측: m05/fig-3 의 순빨강
//   원본 80% → 배포본 0.2%) 웹이 PPT 보다 어둡게 보인다. 저장소의 원본은 PPT 렌더를 그대로 담은
//   파일이므로, 다시 인코딩하지 않고 원본 바이트를 그대로 내보낸다.
//   (Astro 는 import 한 에셋을 해시 파일명으로 그대로 복사한다 — ImageMetadata.src.)
// 이 규칙은 scripts/check-material-images.mjs 가 빌드 산출물(dist)로 지킨다.
export type MaterialImage = { src: string; width: number; height: number };

export function materialImage(meta: ImageMetadata): MaterialImage {
  return { src: meta.src, width: meta.width, height: meta.height };
}
