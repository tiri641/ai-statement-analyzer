import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

test("ApplicationStackのdeployはFRONTEND_ORIGIN未指定で停止する", () => {
  const scriptPath = fileURLToPath(
    new URL("../scripts/verify-ecr-image.mjs", import.meta.url),
  );
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      ECR_IMAGE_TAG: "test-image",
      FRONTEND_ORIGIN: "",
    },
  });

  assert.equal(result.status, 1);
  assert.match(`${result.stdout}\n${result.stderr}`, /FRONTEND_ORIGIN/);
});
