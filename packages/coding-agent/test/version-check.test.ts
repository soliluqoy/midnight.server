import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	checkForNewMidnightRelease,
	checkForNewPiVersion,
	comparePackageVersions,
	formatVersionCheckError,
	getLatestPiRelease,
	getLatestPiVersion,
	isNewerPackageVersion,
	parseGitHubReleases,
} from "../src/utils/version-check.ts";
import { allowNetwork } from "./test-network-env.ts";

const originalSkipVersionCheck = process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK;

beforeEach(() => {
	allowNetwork();
});

afterEach(() => {
	vi.unstubAllGlobals();
	if (originalSkipVersionCheck === undefined) {
		delete process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK;
	} else {
		process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK = originalSkipVersionCheck;
	}
});

describe("version checks", () => {
	it("compares package versions", () => {
		expect(comparePackageVersions("0.70.6", "0.70.5")).toBeGreaterThan(0);
		expect(comparePackageVersions("0.70.5", "0.70.5")).toBe(0);
		expect(comparePackageVersions("0.70.4", "0.70.5")).toBeLessThan(0);
		expect(comparePackageVersions("5.0.0-beta.20", "5.0.0-beta.9")).toBeGreaterThan(0);
		expect(isNewerPackageVersion("0.70.5", "0.70.5")).toBe(false);
		expect(isNewerPackageVersion("0.70.6", "0.70.5")).toBe(true);
	});

	it("returns only newer versions", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.3" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		await expect(checkForNewPiVersion("1.2.2")).resolves.toEqual({ version: "1.2.3" });
	});

	it("uses the pi.dev version check api with a pi user agent", async () => {
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledWith(
			"https://pi.dev/api/latest-version",
			expect.objectContaining({
				headers: expect.objectContaining({
					"User-Agent": expect.stringMatching(/^pi\/1\.2\.3 /),
					accept: "application/json",
				}),
			}),
		);
	});

	it("retries a transient version request when explicitly requested", async () => {
		const fetchMock = vi
			.fn()
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockRejectedValueOnce(new Error("fetch failed"))
			.mockResolvedValueOnce(Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3", { retry: true })).resolves.toEqual({ version: "1.2.4" });
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("keeps automatic version checks to one request", async () => {
		const fetchMock = vi.fn().mockRejectedValue(new Error("fetch failed"));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).toHaveBeenCalledOnce();
	});

	it("formats nested network error details", () => {
		const error = new Error("fetch failed", {
			cause: new AggregateError([
				Object.assign(new Error("connect timeout"), { code: "ETIMEDOUT" }),
				Object.assign(new Error("network unreachable"), { code: "ENETUNREACH" }),
			]),
		});

		expect(formatVersionCheckError(error)).toBe("fetch failed (ETIMEDOUT, ENETUNREACH)");
	});

	it("returns the active package metadata from the version check api", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				packageName: "@new-scope/pi",
				version: "1.2.4",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({
			packageName: "@new-scope/pi",
			version: "1.2.4",
		});
	});

	it("returns update notes from the version check api", async () => {
		const fetchMock = vi.fn(async () => Response.json({ note: " **Read this** ", version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiRelease("1.2.3")).resolves.toEqual({ note: "**Read this**", version: "1.2.4" });
	});

	it("skips automatic api calls when version checks are disabled", async () => {
		process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewPiVersion("1.2.3")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("allows direct api calls when automatic version checks are disabled", async () => {
		process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn(async () => Response.json({ version: "1.2.4" }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(getLatestPiVersion("1.2.3")).resolves.toBe("1.2.4");
		expect(fetchMock).toHaveBeenCalledOnce();
	});
});

describe("midnight.server release checks", () => {
	const release = (tag: string, extra: Record<string, unknown> = {}) => ({
		tag_name: tag,
		html_url: `https://github.com/soliluqoy/midnight.server/releases/tag/${tag}`,
		...extra,
	});

	it("picks the newest non-draft semver release, including pre-releases", () => {
		expect(
			parseGitHubReleases([
				release("v0.1.0"),
				release("v0.3.0", { draft: true }),
				release("v0.2.0-beta.1", { prerelease: true }),
				release("nightly"),
			]),
		).toEqual({
			version: "0.2.0-beta.1",
			url: "https://github.com/soliluqoy/midnight.server/releases/tag/v0.2.0-beta.1",
		});
		expect(parseGitHubReleases({ message: "Not Found" })).toBeUndefined();
		expect(parseGitHubReleases([])).toBeUndefined();
	});

	it("reports only newer releases from the GitHub releases api", async () => {
		const fetchMock = vi.fn(async () => Response.json([release("v0.2.0")]));
		vi.stubGlobal("fetch", fetchMock);

		await expect(checkForNewMidnightRelease("0.2.0")).resolves.toBeUndefined();
		await expect(checkForNewMidnightRelease("0.1.0")).resolves.toEqual({
			version: "0.2.0",
			url: "https://github.com/soliluqoy/midnight.server/releases/tag/v0.2.0",
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://api.github.com/repos/soliluqoy/midnight.server/releases?per_page=10",
			expect.anything(),
		);
	});

	it("never throws and skips the request when version checks are disabled", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));
		await expect(checkForNewMidnightRelease("0.1.0")).resolves.toBeUndefined();

		process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK = "1";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		await expect(checkForNewMidnightRelease("0.1.0")).resolves.toBeUndefined();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
