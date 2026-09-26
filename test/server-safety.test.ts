import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isAllowedServerHost,
  isLoopbackHost,
} from "../src/server-safety.ts";

test("ローカルホストは許可する", () => {
  assert.equal(isLoopbackHost("127.0.0.1"), true);
  assert.equal(isLoopbackHost("::1"), true);
  assert.equal(isLoopbackHost("localhost"), true);
});

test("ネットワーク公開用のHostは認証なしでは許可しない", () => {
  assert.equal(isLoopbackHost("0.0.0.0"), false);
  assert.equal(isLoopbackHost("10.0.0.10"), false);
});

test("ECS用の明示的な許可がある場合だけ非loopback Hostを許可する", () => {
  assert.equal(isAllowedServerHost("0.0.0.0", true), true);
  assert.equal(isAllowedServerHost("10.0.0.10", true), true);
  assert.equal(isAllowedServerHost("0.0.0.0", false), false);
});
