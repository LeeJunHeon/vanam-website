// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import cloudflare from '@astrojs/cloudflare';
import basicSsl from '@vitejs/plugin-basic-ssl';

// Keystatic 관리자는 dev에서 로컬 파일을 직접 읽고 써야 하므로(로컬 모드),
// dev 서버는 순수 Node로 돌리고 Cloudflare 어댑터는 빌드(astro build)에만 적용한다.
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

// https://astro.build/config
export default defineConfig({
  site: 'https://vanam.co.kr',

  // Cloudflare 어댑터: 일반 페이지는 지금처럼 전부 정적으로 미리 생성되고,
  // Keystatic 관리자(/keystatic, /api/keystatic)만 서버에서 동작한다.
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
    // dev 서버를 자체서명 HTTPS로 제공: Keystatic이 쓰는 crypto.subtle이
    // 보안 컨텍스트(HTTPS/localhost) 전용이라, 사내망 편집자가
    // https://192.168.0.132:4321 로 접속할 수 있게 한다. 빌드에는 미적용.
    plugins: isBuild ? [tailwindcss()] : [tailwindcss(), basicSsl(), cloudflareWorkersDevShim],
  },

  integrations: [
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
