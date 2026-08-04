// @ts-check
import { rmSync } from 'node:fs';
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import cloudflare from '@astrojs/cloudflare';

// dev 서버는 순수 Node로 돌리고, Cloudflare 어댑터는 빌드(astro build)에만 적용한다.
// (dev 에서 workerd 를 쓰면 React 가 CJS 로 로드되며 깨진다)
const isBuild = process.argv.includes('build');

// dev 서버는 순수 Node로 돌기 때문에 workerd 내장 모듈인 'cloudflare:workers'가 없다.
// 배포(workerd)에서는 진짜 모듈이 쓰이고, dev에서는 이 빈 shim이 쓰인다.
// (Astro 6부터 Astro.locals.runtime.env 가 제거되어, 환경변수는 이 모듈에서 읽어야 한다)
const cloudflareWorkersDevShim = {
  name: 'vanam:cloudflare-workers-dev-shim',
  resolveId(id) {
    if (id === 'cloudflare:workers') return '\0vanam-cf-workers-shim';
  },
  load(id) {
    if (id === '\0vanam-cf-workers-shim') return 'export const env = {};';
  },
};

// ── 빌드 시작 시 콘텐츠 레이어 캐시 삭제 (지뢰 ㊶ 의 근본 대책) ─────────────
// Astro 는 콘텐츠 컬렉션을 node_modules/.astro/data-store.json 에 캐시하는데,
// 이 캐시는 **삭제된 항목을 지워주지 않는다.** 그래서 글을 지워도 다음 빌드에서
// 유령 페이지가 그대로 생성된다.
//
// 지금까지는 맥미니에서 빌드 전에 손으로 지워서 넘겼지만, Cloudflare 빌드 서버는
// node_modules 를 캐시해 재사용하므로 그쪽 유령은 아무도 못 지웠다.
// 실제로 0156 에서 지운 블로그 샘플이 /blog/selectusa-2026 로 라이브에 계속 살아 있었다
// (소스에는 없고 Keystatic 에도 없는데 화면에는 보이는 상태).
//
// → 빌드에서는 누가 어떻게 실행하든 항상 이 캐시를 지우고 시작한다. dev 는 건드리지 않는다.
const clearContentLayerCache = {
  name: 'vanam:clear-content-layer-cache',
  hooks: {
    'astro:config:setup': ({ command, logger }) => {
      if (command !== 'build') return;
      rmSync(new URL('./node_modules/.astro/data-store.json', import.meta.url), { force: true });
      logger.info('콘텐츠 레이어 캐시 삭제 — 삭제된 콘텐츠가 유령 페이지로 남는 것 방지');
    },
  },
};

// https://astro.build/config
export default defineConfig({
  site: 'https://vanam.co.kr',

  // Cloudflare 어댑터: 일반 페이지는 전부 정적으로 미리 생성되고,
  // 주문·문의·관리자·Keystatic UI 만 서버(워커)에서 동작한다.
  adapter: isBuild
    ? cloudflare({
        // 이미지는 기존처럼 빌드 시점에 webp로 최적화 (Cloudflare 유료 이미지 리사이징 불필요)
        imageService: 'compile',
      })
    : undefined,

  // i18n: 기본 영문(접두사 없음), 한글은 /ko 접두사
  i18n: {
    locales: ['en', 'ko'],
    defaultLocale: 'en',
    routing: { prefixDefaultLocale: false },
  },

  vite: {
    // ⚠️ basicSsl(자체서명 HTTPS)은 제거했다.
    //   원래는 사내망 편집자가 https://192.168.0.132:4321/keystatic 으로 들어오게 하려던 것이었다
    //   (Keystatic 이 쓰는 crypto.subtle 은 보안 컨텍스트 전용이라 http://192.168.0.132 로는 안 된다).
    //   이제 편집자는 배포된 사이트의 /keystatic 을 쓰므로 그 목적이 사라졌고,
    //   오히려 Keystatic Cloud 의 로컬 허용 주소가 http://127.0.0.1 이라 HTTPS 면 인증이 안 맞는다.
    //   localhost/127.0.0.1 은 HTTP 여도 보안 컨텍스트라 crypto.subtle 이 그대로 동작한다.
    plugins: isBuild ? [tailwindcss()] : [tailwindcss(), cloudflareWorkersDevShim],
  },

  integrations: [
    clearContentLayerCache,  // ⚠️ 항상 맨 앞 — 콘텐츠를 읽기 전에 캐시를 지워야 한다
    react(),      // Keystatic 관리자 UI가 React 기반
    keystatic(),  // /keystatic 관리자 + /api/keystatic 라우트 주입
    sitemap({
      i18n: {
        defaultLocale: 'en',
        locales: { en: 'en', ko: 'ko' },
      },
    }),
  ],
});
