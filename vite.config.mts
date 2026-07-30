import { defineConfig } from 'vite';

export default defineConfig({
  base: '', // relative asset paths, required for Contentful-hosted app bundles
  build: { outDir: 'build', sourcemap: true },
});
