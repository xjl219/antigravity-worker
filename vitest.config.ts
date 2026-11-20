import {defineConfig} from "vitest/config";
import {fileURLToPath} from "node:url";

export default defineConfig({
  resolve: {
    alias: {
      "cloudflare:workers": fileURLToPath(new URL("./test/mocks/cloudflare-workers.ts", import.meta.url))
    }
  },
  test: {
    environment: "node"
  }
});
