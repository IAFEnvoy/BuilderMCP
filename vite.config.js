import { defineConfig } from 'vite';

export default defineConfig({
  clearScreen: false,
  server: { watch: { ignored: ['**/src-tauri/target/**', '**/src-tauri/gen/**'] } },
  build: {
    target: 'es2022',
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'three-core', test: /[\\/]three\.core\.js$/, priority: 2 },
            { name: 'three-renderer', test: /[\\/]node_modules[\\/]three[\\/]/ },
          ],
        },
      },
    },
  },
});
