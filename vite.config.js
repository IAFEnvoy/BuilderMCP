import { readFileSync } from 'node:fs';
import { defineConfig } from 'vite';

const cargoManifest = readFileSync(new URL('./src-tauri/Cargo.toml', import.meta.url), 'utf8');
const cargoPackage = cargoManifest.split(/^\[package\][ \t]*$/m)[1]?.split(/^\[/m)[0];
const softwareVersion = cargoPackage?.match(/^[ \t]*version[ \t]*=[ \t]*(["'])([^"']+)\1/m)?.[2];
if (!softwareVersion) throw new Error('Could not read the Builder MCP version from src-tauri/Cargo.toml.');

export default defineConfig({
  clearScreen: false,
  define: { __BUILDER_MCP_VERSION__: JSON.stringify(softwareVersion) },
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
