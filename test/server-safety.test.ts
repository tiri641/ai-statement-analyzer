import assert from "node:assert/strict";
import { test } from "node:test";
import { isLoopbackHost } from "../src/server-safety.ts";

test("ローカルホストは許可する", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
});

test("ネットワーク公開用のHostは認証なしでは許可しない", () => {
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("10.0.0.10"), false);
});
