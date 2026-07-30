import { defineConfig } from 'vite';

export default defineConfig({
  base: '', // relative asset paths, required for Contentful-hosted app bundles
  build: {
    outDir: 'build',
    sourcemap: true,
    // Do NOT wipe build/ — the Function bundle from build-functions lands here too.
    emptyOutDir: false,
  },
});
