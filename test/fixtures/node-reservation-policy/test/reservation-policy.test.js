import assert from "node:assert/strict";
import test from "node:test";
import { canReserve } from "../src/reservation-policy.js";

test("reservation admits the exact remaining capacity boundary", () => {
  assert.equal(canReserve(2, 2), true);
});

test("reservation refuses excess, zero, and non-integer requests", () => {
  assert.equal(canReserve(2, 3), false);
  assert.equal(canReserve(2, 0), false);
  assert.equal(canReserve(2, 1.5), false);
});
