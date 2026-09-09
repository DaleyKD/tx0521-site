// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  output: 'static',
  site: 'https://www.tx0521.org',
  trailingSlash: 'never',
  integrations: [sitemap()],
});
