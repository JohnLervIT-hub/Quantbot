import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

export default defineConfig({
  plugins: [
    react(),
    visualizer({ filename: 'dist/stats.html', open: false, gzipSize: true }),
  ],
  server: {
    proxy: {
      '/bridge': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bridge/, ''),
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) return 'vendor';
          if (id.includes('node_modules/framer-motion/') || id.includes('node_modules/motion-dom/') || id.includes('node_modules/motion-utils/')) return 'motion';
          if (id.includes('node_modules/lightweight-charts/') || id.includes('node_modules/fancy-canvas/')) return 'charts';
          if (id.includes('node_modules/chart.js/') || id.includes('node_modules/@kurkle/')) return 'chartjs';
          if (id.includes('node_modules/@supabase/')) return 'supabase';
        },
      },
    },
    chunkSizeWarningLimit: 450,
  },
})
