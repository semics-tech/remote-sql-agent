import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:8080', changeOrigin: true },
      '/health': { target: 'http://localhost:8080', changeOrigin: true },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
    rollupOptions: {
      output: {
        // Monaco is large and only needed on the Versions tab; keeping it in
        // its own chunk stops it blocking first paint of the estate grid.
        //
        // Expressed as a function because Vite 8 is rolldown-based and dropped
        // the object form. Matching on the module id rather than naming an
        // entry point also catches monaco-editor's own deep ESM imports, which
        // the object form never did — the editor core was landing in the main
        // bundle regardless.
        manualChunks: (id) => (id.includes('monaco-editor') ? 'monaco' : undefined),
      },
    },
  },
});
