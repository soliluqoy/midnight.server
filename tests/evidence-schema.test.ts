import assert from "node:assert/strict";
import { test } from "node:test";
import { Value } from "typebox/value";
import { PublicEvidenceParams, StrictPublicEvidenceParams } from "../src/evidence/public-params.ts";

test("evidence tool publishes an object-root schema and retains action-specific validation", () => {
	assert.equal(PublicEvidenceParams.type, "object");
	for (const request of [
		{ action: "list" },
		{ action: "add", kind: "gap", text: "Unknown behavior" },
		{ action: "preview", selected: [] },
		{ action: "archive", locator: "cursor" },
		{ action: "audit", selected: ["claim-id"] },
	]) {
		assert.equal(Value.Check(PublicEvidenceParams, request), true);
		assert.equal(Value.Check(StrictPublicEvidenceParams, request), true);
	}
	for (const request of [
		{ action: "preview" },
		{ action: "audit", selected: [] },
		{ action: "archive" },
		{ action: "list", selected: [] },
		{ action: "preview", selected: [], locator: "cursor" },
	]) {
		assert.equal(Value.Check(StrictPublicEvidenceParams, request), false);
	}
	assert.equal(Value.Check(PublicEvidenceParams, { action: "unknown" }), false);
});
