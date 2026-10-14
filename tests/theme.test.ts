import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	SettingsManager,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import { loadThemeFromPath } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
// Validate with the pinned host's parser, not a second copy of the theme schema.
import { validateThemeJson } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme-schema.js";
import { applyDefaultTheme, MIDNIGHT_THEME } from "../src/theme.ts";

const themePath = fileURLToPath(new URL("../themes/midnight.json", import.meta.url));

test("package ships a valid Midnight theme with blue accents and thinking borders", async () => {
	const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	assert.ok(manifest.files.includes("themes"));
	assert.deepEqual(manifest.pi.themes, ["./themes/midnight.json"]);
	const json = validateThemeJson(themePath, JSON.parse(await readFile(themePath, "utf8")));
	assert.equal(json.name, MIDNIGHT_THEME);
	const theme = loadThemeFromPath(themePath, "truecolor");
	assert.equal(theme.appearance, "dark");
	assert.equal(theme.getFgAnsi("accent"), "\x1b[38;2;108;182;255m");
	assert.equal(theme.getFgAnsi("thinkingXhigh"), "\x1b[38;2;145;203;255m");
	const blueTokens: ThemeColor[] = [
		"accent",
		"border",
		"borderAccent",
		"customMessageLabel",
		"mdHeading",
		"mdLink",
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
	];
	for (const token of blueTokens) {
		const ansi = theme
			.getFgAnsi(token)
			.slice(1)
			.match(/^\[38;2;(\d+);(\d+);(\d+)m$/);
		assert.ok(ansi, `${token} must resolve to a truecolor foreground`);
		const [, red, green, blue] = ansi.map(Number);
		assert.ok(blue > green && green > red, `${token} must stay blue, not purple/pink`);
	}
	// Keep warning, error, and diff colors distinct from the blue controls.
	for (const token of ["success", "warning", "error", "toolDiffAdded", "toolDiffRemoved"] as const) {
		assert.notEqual(theme.getFgAnsi(token), theme.getFgAnsi("accent"));
	}
	const indexed = loadThemeFromPath(themePath, "256color");
	assert.match(indexed.getFgAnsi("accent").slice(1), /^\[38;5;\d+m$/);
});

function luminance(ansi: string): number {
	const match = ansi.slice(1).match(/^\[(?:38|48);2;(\d+);(\d+);(\d+)m$/);
	assert.ok(match, "contrast checks require truecolor tokens");
	const rgb = match.slice(1).map((value) => {
		const channel = Number(value) / 255;
		return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
	});
	return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}

test("Midnight Signal keeps passive chrome quiet and thinking borders progressively brighter", () => {
	const theme = loadThemeFromPath(themePath, "truecolor");
	assert.ok(luminance(theme.getFgAnsi("borderMuted")) < luminance(theme.getFgAnsi("border")));
	assert.ok(luminance(theme.getFgAnsi("border")) < luminance(theme.getFgAnsi("accent")));
	assert.ok(luminance(theme.getFgAnsi("accent")) < luminance(theme.getFgAnsi("borderAccent")));
	const thinking: ThemeColor[] = [
		"thinkingOff",
		"thinkingMinimal",
		"thinkingLow",
		"thinkingMedium",
		"thinkingHigh",
		"thinkingXhigh",
		"thinkingMax",
	];
	for (let index = 1; index < thinking.length; index++) {
		assert.ok(
			luminance(theme.getFgAnsi(thinking[index])) > luminance(theme.getFgAnsi(thinking[index - 1])),
			thinking[index],
		);
	}
	assert.equal(theme.getFgAnsi("syntaxFunction"), theme.getFgAnsi("borderAccent"));
	assert.notEqual(theme.getFgAnsi("success"), theme.getFgAnsi("warning"));
	assert.notEqual(theme.getFgAnsi("warning"), theme.getFgAnsi("error"));
});

test("body, metadata, and dim text retain 4.5:1 contrast on every Midnight surface", () => {
	const theme = loadThemeFromPath(themePath, "truecolor");
	for (const background of [
		"selectedBg",
		"userMessageBg",
		"customMessageBg",
		"toolPendingBg",
		"toolSuccessBg",
		"toolErrorBg",
	] as const) {
		for (const foreground of ["text", "muted", "dim", "toolOutput"] as const) {
			const fg = luminance(theme.getFgAnsi(foreground));
			const bg = luminance(theme.getBgAnsi(background));
			assert.ok((fg + 0.05) / (bg + 0.05) >= 4.5, `${foreground} on ${background}`);
		}
	}
	const indexed = loadThemeFromPath(themePath, "256color");
	for (const token of ["accent", "border", "borderAccent", "success", "warning", "error"] as const) {
		assert.match(indexed.getFgAnsi(token).slice(1), /^\[38;5;\d+m$/);
	}
	assert.match(indexed.getBgAnsi("selectedBg").slice(1), /^\[48;5;\d+m$/);
});

test("installed packages and CLI package directories discover both extension and theme", async (t) => {
	const dir = await mkdtemp(join(tmpdir(), "midnight-theme-"));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const root = fileURLToPath(new URL("..", import.meta.url));
	for (const cli of [false, true]) {
		const loader = new DefaultResourceLoader({
			cwd: dir,
			agentDir: dir,
			settingsManager: SettingsManager.inMemory({ packages: cli ? [] : [root] }),
			additionalExtensionPaths: cli ? [root] : [],
			noSkills: true,
			noPromptTemplates: true,
			noContextFiles: true,
		});
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.equal(loader.getExtensions().extensions.length, 1);
		const { themes, diagnostics } = loader.getThemes();
		assert.deepEqual(diagnostics, []);
		assert.deepEqual(
			themes.map((theme) => theme.name),
			[MIDNIGHT_THEME],
		);
	}
});

function harness(
	options: { mode?: ExtensionContext["mode"]; preference?: string; active?: string; failure?: string } = {},
) {
	let preference = options.preference;
	const calls: string[] = [];
	const notifications: { message: string; type: string }[] = [];
	const pi = { getSettings: () => ({ theme: preference }) } as unknown as ExtensionAPI;
	const ctx = {
		mode: options.mode ?? "tui",
		ui: {
			theme: { name: options.active ?? "system" },
			setTheme(name: string) {
				calls.push(name);
				if (options.failure) return { success: false, error: options.failure };
				preference = name;
				return { success: true };
			},
			notify(message: string, type: string) {
				notifications.push({ message, type });
			},
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, calls, notifications };
}

test("interactive startup selects and saves Midnight only when no preference exists", () => {
	const { pi, ctx, calls, notifications } = harness();
	applyDefaultTheme(pi, ctx);
	assert.deepEqual(calls, [MIDNIGHT_THEME]);
	assert.equal(pi.getSettings().theme, MIDNIGHT_THEME);
	assert.deepEqual(notifications, []);
	applyDefaultTheme(pi, ctx);
	assert.deepEqual(calls, [MIDNIGHT_THEME], "reload/resume must not reapply the default");
});

test("explicit user/project/CLI themes, including system and automatic pairs, are preserved", () => {
	for (const preference of ["system", "dark", "light", "custom", "light/dark", "system/midnight", MIDNIGHT_THEME]) {
		const { pi, ctx, calls } = harness({ preference });
		applyDefaultTheme(pi, ctx);
		assert.deepEqual(calls, [], preference);
		assert.equal(pi.getSettings().theme, preference);
	}
	const { pi, ctx, calls } = harness({ active: "another-extension-theme" });
	applyDefaultTheme(pi, ctx);
	assert.deepEqual(calls, [], "do not replace a theme instance installed by another extension");
});

test("non-interactive modes do not touch settings or UI", () => {
	for (const mode of ["rpc", "json", "print"] as const) {
		applyDefaultTheme({} as ExtensionAPI, { mode } as ExtensionContext);
	}
});

test("missing or invalid bundled theme reports how to load the package without saving a preference", () => {
	const { pi, ctx, calls, notifications } = harness({ failure: "Theme not found: midnight" });
	applyDefaultTheme(pi, ctx);
	assert.deepEqual(calls, [MIDNIGHT_THEME]);
	assert.equal(pi.getSettings().theme, undefined);
	assert.equal(notifications.length, 1);
	assert.equal(notifications[0].type, "warning");
	assert.match(notifications[0].message, /Theme not found: midnight/);
	assert.match(notifications[0].message, /package directory/);
});
