import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  html: {
    cspNonce: undefined,
  },
  build: {
    crossOriginLoading: false,
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        panel: path.resolve(__dirname, 'src/renderer/panel.html'),
        overlay: path.resolve(__dirname, 'src/renderer/overlay.html'),
        stream: path.resolve(__dirname, 'src/renderer/stream.html'),
      },
      output: {
        // Three independent renderer entries (panel/overlay/stream) all
        // pull react + react-dom + jsx-runtime. Without manualChunks
        // each bundle inlines its own copy, so the installer ships
        // React three times. Pull shared deps into a single chunk that
        // browser/Electron caches across windows.
        manualChunks: {
          react: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  // NOTE: `process.platform` used to be inlined here at build time, but
  // that meant the build host's platform leaked into the renderer (a
  // CI build of a macOS dmg on Linux would ship `linux` to the
  // renderer). Renderers now read `window.flicky.platform`, exposed
  // via the preload at runtime.
  server: {
    port: 5173,
  },
});
