import { compare, valid } from "semver";
import { fetchWithRetry } from "./management-http.ts";
import { getPiUserAgent } from "./pi-user-agent.ts";

const LATEST_VERSION_URL = "https://pi.dev/api/latest-version";
const DEFAULT_VERSION_CHECK_TIMEOUT_MS = 10000;

export interface LatestPiRelease {
	version: string;
	packageName?: string;
	note?: string;
}

/** Include useful errno details hidden behind Node's generic "fetch failed" error. */
export function formatVersionCheckError(error: unknown): string {
	const rootMessage = error instanceof Error && error.message ? error.message : String(error);
	const cause = error instanceof Error ? error.cause : undefined;
	const causes = cause instanceof AggregateError ? cause.errors : cause === undefined ? [] : [cause];
	const codes = causes
		.map((value) =>
			typeof value === "object" && value !== null && "code" in value && typeof value.code === "string"
				? value.code
				: undefined,
		)
		.filter((code): code is string => code !== undefined);

	if (codes.length > 0) return `${rootMessage} (${[...new Set(codes)].join(", ")})`;
	const causeMessage = causes.find(
		(value): value is Error => value instanceof Error && Boolean(value.message),
	)?.message;
	return causeMessage ? `${rootMessage} (cause: ${causeMessage})` : rootMessage;
}

export function comparePackageVersions(leftVersion: string, rightVersion: string): number | undefined {
	const left = valid(leftVersion.trim());
	const right = valid(rightVersion.trim());
	if (!left || !right) {
		return undefined;
	}
	return compare(left, right);
}

export function isNewerPackageVersion(candidateVersion: string, currentVersion: string): boolean {
	const comparison = comparePackageVersions(candidateVersion, currentVersion);
	if (comparison !== undefined) {
		return comparison > 0;
	}
	return candidateVersion.trim() !== currentVersion.trim();
}

export async function getLatestPiRelease(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<LatestPiRelease | undefined> {
	if (process.env.MIDNIGHT_SERVER_OFFLINE) return undefined;

	const response = await fetchWithRetry(
		LATEST_VERSION_URL,
		{
			headers: {
				"User-Agent": getPiUserAgent(currentVersion),
				accept: "application/json",
			},
		},
		{
			maxRetries: options.retry ? 2 : 0,
			timeoutMs: options.timeoutMs ?? DEFAULT_VERSION_CHECK_TIMEOUT_MS,
		},
	);
	if (!response.ok) return undefined;

	const data = (await response.json()) as {
		packageName?: unknown;
		version?: unknown;
		note?: unknown;
	};
	if (typeof data.version !== "string" || !data.version.trim()) {
		return undefined;
	}
	const packageName =
		typeof data.packageName === "string" && data.packageName.trim() ? data.packageName.trim() : undefined;
	const note = typeof data.note === "string" && data.note.trim() ? data.note.trim() : undefined;
	return {
		version: data.version.trim(),
		packageName,
		...(note ? { note } : {}),
	};
}

export async function getLatestPiVersion(
	currentVersion: string,
	options: { timeoutMs?: number; retry?: boolean } = {},
): Promise<string | undefined> {
	return (await getLatestPiRelease(currentVersion, options))?.version;
}

export async function checkForNewPiVersion(currentVersion: string): Promise<LatestPiRelease | undefined> {
	if (process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK) return undefined;

	try {
		const latestRelease = await getLatestPiRelease(currentVersion);
		if (latestRelease && isNewerPackageVersion(latestRelease.version, currentVersion)) {
			return latestRelease;
		}
		return undefined;
	} catch {
		return undefined;
	}
}

const MIDNIGHT_RELEASES_URL = "https://api.github.com/repos/soliluqoy/midnight.server/releases?per_page=10";

export interface MidnightRelease {
	version: string;
	/** Release page to download from and read the notes. */
	url: string;
}

/**
 * Newest published release from a GitHub `/releases` response. Drafts and tags that
 * are not semver (after an optional leading `v`) are skipped. Pre-releases count:
 * `/releases/latest` would hide them, and midnight.server is pre-release for now.
 */
export function parseGitHubReleases(data: unknown): MidnightRelease | undefined {
	if (!Array.isArray(data)) return undefined;
	let newest: MidnightRelease | undefined;
	for (const entry of data) {
		if (typeof entry !== "object" || entry === null) continue;
		const release = entry as { tag_name?: unknown; html_url?: unknown; draft?: unknown };
		if (release.draft === true || typeof release.tag_name !== "string" || typeof release.html_url !== "string") {
			continue;
		}
		const version = valid(release.tag_name.trim().replace(/^v/, ""));
		if (!version) continue;
		if (!newest || compare(version, newest.version) > 0) newest = { version, url: release.html_url };
	}
	return newest;
}

/** Startup update check against midnight.server's GitHub releases. Never throws. */
export async function checkForNewMidnightRelease(currentVersion: string): Promise<MidnightRelease | undefined> {
	if (process.env.MIDNIGHT_SERVER_SKIP_VERSION_CHECK || process.env.MIDNIGHT_SERVER_OFFLINE) return undefined;
	try {
		const response = await fetchWithRetry(
			MIDNIGHT_RELEASES_URL,
			{ headers: { "User-Agent": getPiUserAgent(currentVersion), accept: "application/vnd.github+json" } },
			{ maxRetries: 0, timeoutMs: DEFAULT_VERSION_CHECK_TIMEOUT_MS },
		);
		if (!response.ok) return undefined;
		const latest = parseGitHubReleases(await response.json());
		return latest && isNewerPackageVersion(latest.version, currentVersion) ? latest : undefined;
	} catch {
		return undefined;
	}
}
