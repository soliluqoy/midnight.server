import { describe, expect, it } from "vitest";
import { ENV_AGENT_DIR, ENV_SESSION_DIR, getAgentDir } from "../src/config.ts";

describe("midnight configuration", () => {
	it("uses shell-compatible environment variable names", () => {
		expect(ENV_AGENT_DIR).toBe("MIDNIGHT_SERVER_CODING_AGENT_DIR");
		expect(ENV_SESSION_DIR).toBe("MIDNIGHT_SERVER_CODING_AGENT_SESSION_DIR");
	});

	it("honors the product-specific agent directory override", () => {
		const original = process.env[ENV_AGENT_DIR];
		try {
			process.env[ENV_AGENT_DIR] = process.cwd();
			expect(getAgentDir()).toBe(process.cwd());
		} finally {
			if (original === undefined) delete process.env[ENV_AGENT_DIR];
			else process.env[ENV_AGENT_DIR] = original;
		}
	});
});
