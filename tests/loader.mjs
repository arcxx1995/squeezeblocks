// Test-only ESM loader: transpiles .ts on the fly and aliases
// `@devvit/web/server` to the in-memory shim, so the real server logic
// (game.ts, engine.ts, notify.ts) runs under plain Node with no Devvit runtime.
// Usage: node --no-warnings --experimental-loader ./tests/loader.mjs <test.mjs>
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const SHIM = new URL("./devvit-shim.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "@devvit/web/server") {
    return { url: SHIM, shortCircuit: true };
  }
  // Add .ts/.tsx for relative imports written without an extension.
  if (specifier.startsWith(".") && context.parentURL) {
    const base = new URL(specifier, context.parentURL);
    if (!existsSync(fileURLToPath(base))) {
      for (const ext of [".ts", ".tsx"]) {
        const cand = new URL(specifier + ext, context.parentURL);
        if (existsSync(fileURLToPath(cand))) return { url: cand.href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(".ts") || url.endsWith(".tsx")) {
    const src = readFileSync(fileURLToPath(url), "utf8");
    const out = ts.transpileModule(src, {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
      fileName: fileURLToPath(url),
    });
    return { format: "module", source: out.outputText, shortCircuit: true };
  }
  return nextLoad(url, context);
}
