import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("アプリケーションImageはAPIを既定Commandとして起動する", async () => {
  const dockerfile = await readFile("Dockerfile", "utf8");

  assert.match(dockerfile, /npm ci/);
  assert.match(dockerfile, /npm run build/);
  assert.match(dockerfile, /COPY --from=build .*dist/);
  assert.match(dockerfile, /COPY --from=build .*migrations/);
  assert.match(dockerfile, /USER node/);
  assert.match(dockerfile, /CMD \["node", "dist\/server\.js"\]/);
});

test("Docker build contextは秘密情報と生成物を含めない", async () => {
  const dockerignore = await readFile(".dockerignore", "utf8");

  assert.match(dockerignore, /^\.env$/m);
  assert.match(dockerignore, /^node_modules\/$/m);
  assert.match(dockerignore, /^dist\/$/m);
  assert.match(dockerignore, /^cdk\.out\/$/m);
});
