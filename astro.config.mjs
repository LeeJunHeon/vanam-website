// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import sitemap from '@astrojs/sitemap';
import react from '@astrojs/react';
import keystatic from '@keystatic/astro';
import cloudflare from '@astrojs/cloudflare';

// Keystatic 관리자는 dev에서 로컬 파일을 직접 읽고 써야 하므로(로컬 모드),
// dev 서버는 순수 Node로 돌리고 Cloudflare 어댑터는 빌드(astro build)에만 적용한다.
const isBuild = process.argv.includes('build');

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
    plugins: [tailwindcss()]
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
