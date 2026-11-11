import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: Number(process.env.VITE_PORT || 5173),
    strictPort: true,
    fs: { allow: ['../..'] },
    proxy: { '/api': process.env.KONTUR_API_TARGET || 'http://127.0.0.1:4000' },
  },
});
