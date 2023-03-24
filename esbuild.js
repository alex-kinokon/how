#!/usr/bin/env node
const fs = require("fs");
const { build } = require("esbuild");

if (!process.env.OPENAI_API_KEY) {
  throw new Error("Missing environment variable: OPENAI_API_KEY");
}

build({
  entryPoints: ["src/index.ts"],
  outfile: "lib/index.js",
  format: "cjs",
  bundle: true,
  platform: "node",
  target: "node14",
  minify: true,
  define: {
    "process.env.OPENAI_API_KEY": JSON.stringify(process.env.OPENAI_API_KEY),
  },
  banner: {
    js: "#!/usr/bin/env node",
  },
}).then(() => {
  fs.chmodSync("lib/index.js", "755");
});
