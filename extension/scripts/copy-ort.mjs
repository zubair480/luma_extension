/**
 * Copy ONNX Runtime WASM artifacts into the extension (required for MV3 CSP).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, "..");
const srcDir = path.join(root, "node_modules", "@huggingface", "transformers", "dist");
const destDir = path.join(root, "vendor", "ort");

const files = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];

fs.mkdirSync(destDir, { recursive: true });

for (const file of files) {
  const src = path.join(srcDir, file);
  if (!fs.existsSync(src)) {
    console.error(`Missing ${src} — run npm install first`);
    process.exit(1);
  }
  fs.copyFileSync(src, path.join(destDir, file));
  fs.copyFileSync(src, path.join(root, "offscreen", file));
  console.log(`Copied ${file}`);
}
