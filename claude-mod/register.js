const PANE = "midnight-sidebar";
let epoch = 0;
let revision = 0;
let enabled = false;
let cwd = "";
let model = "";
let usage = null;
let status = null;
let error = "";
let pending = null;
let refreshRequested = false;
let view = { kind: "status" };

function text(value) {
	return String(value ?? "").replace(/[\p{Cc}\p{Cf}]/gu, " ");
}

async function read($, command, directory, file, offset = 0, layer = "unstaged") {
	const args = [
		"node",
		"--experimental-strip-types",
		`${$.plugin.root}/src/clients/cli.ts`,
		command,
		"--cwd",
		directory,
		"--limit",
		"40",
		"--offset",
		String(offset),
	];
	if (file !== undefined) args.push(file.startsWith("--") ? `./${file}` : file);
	if (command === "diff") args.push("--layer", layer);
	const result = await $.process.run(args, { cwd: directory, timeoutMs: 8000 });
	if (result.exitCode !== 0 || result.isStdoutTruncated)
		throw new Error(result.stderr || "Midnight's file reader returned incomplete output.");
	return JSON.parse(result.stdout);
}

async function refresh($) {
	if (!enabled) return;
	refreshRequested = true;
	if (pending) return pending;
	const current = epoch;
	pending = (async () => {
		try {
			do {
				refreshRequested = false;
				const [nextCwd, nextModel, nextUsage] = await Promise.all([
					$.session.cwd(),
					$.session.model(),
					$.session.usage(),
				]);
				if (current !== epoch) return;
				if (cwd !== nextCwd) {
					revision++;
					view = { kind: "status" };
				}
				cwd = nextCwd;
				model = nextModel;
				usage = nextUsage;
				const nextStatus = await read($, "status", nextCwd);
				if (current !== epoch) return;
				status = nextStatus;
				error = "";
			} while (refreshRequested && enabled);
		} catch (cause) {
			if (current === epoch) {
				status = null;
				error = text(cause instanceof Error ? cause.message : cause);
			}
		} finally {
			if (current === epoch) {
				pending = null;
				$.ui.invalidate("ui.render");
			}
		}
	})();
	return pending;
}

async function show($, kind, directory, file = ".", offset = 0, layer = "unstaged") {
	const current = epoch;
	const request = ++revision;
	view = { kind, directory, file, offset, layer, loading: true };
	$.ui.invalidate("ui.render");
	try {
		const result = await read($, kind, directory, file, offset, layer);
		if (current === epoch && request === revision) view = { ...view, result, loading: false };
	} catch (cause) {
		if (current === epoch && request === revision)
			view = { ...view, loading: false, error: text(cause instanceof Error ? cause.message : cause) };
	}
	if (current === epoch && request === revision) $.ui.invalidate("ui.render");
}

async function start($, surface) {
	epoch++;
	revision++;
	pending = null;
	refreshRequested = false;
	cwd = "";
	model = "";
	status = null;
	usage = null;
	error = "";
	view = { kind: "status" };
	enabled = surface === "terminal";
	if (!enabled) return;
	await $.ui.open({ id: PANE, title: "Midnight", columns: 36 });
	await refresh($);
}

export function register(on) {
	on("session.start", async ($, e, next) => {
		await start($, e.isInteractive ? e.surface : null);
		await $.command.register({
			name: "midnight-sidebar",
			description: "Show Midnight's native session and Git sidebar",
			argumentHint: "[show|hide|refresh]",
			immediate: true,
		});
		return next(e);
	});
	on("classic.SessionStart", async ($, e, next) => {
		if (e.source === "clear" || e.source === "resume") {
			const surfaces = await $.session.surfaces();
			await start($, surfaces.includes("terminal") ? "terminal" : null);
		} else if (e.source === "compact") {
			await refresh($);
		}
		return next(e);
	});
	on("session.end", async ($, e, next) => {
		enabled = false;
		epoch++;
		revision++;
		pending = null;
		status = null;
		await $.ui.close({ id: PANE });
		return next(e);
	});
	on("ui.close", async (_$, e, next) => {
		if (e.id === PANE) {
			enabled = false;
			epoch++;
			revision++;
			pending = null;
		}
		return next(e);
	});
	on("command.run", { command: "midnight-sidebar" }, async ($, e) => {
		const action = e.args.trim() || "show";
		if (!["show", "hide", "refresh"].includes(action)) return { text: "Use /midnight-sidebar [show|hide|refresh]." };
		if (action === "hide") {
			enabled = false;
			await $.ui.close({ id: PANE });
			return {};
		}
		if (!(await $.session.surfaces()).includes("terminal"))
			return { text: "Open an interactive Claude Code terminal to use the Midnight sidebar." };
		enabled = true;
		await $.ui.open({ id: PANE, title: "Midnight", columns: 36, focus: true });
		await refresh($);
		return {};
	});
	on("turn.complete", async ($, e, next) => {
		const result = await next(e);
		await refresh($);
		return result;
	});
	on("session.measure", async ($, e, next) => {
		usage = e;
		$.ui.invalidate("ui.render");
		return next(e);
	});
	on("ui.render", { component: "Pane" }, ($, e, next) => {
		if (e.requestId !== PANE) return next(e);
		const { Box, Text, Button, Code } = $.ui.resolve(e);
		const line = (value, props = {}) => Text({ ...props, children: [text(value)] });
		const button = (key, label, onPress, hotkey) =>
			Button({ key, label, onPress, plain: true, ...(hotkey ? { hotkey } : {}) });
		const home = () => {
			revision++;
			view = { kind: "status" };
			$.ui.invalidate("ui.render");
		};
		const children = [
			Box({
				flexDirection: "row",
				columnGap: 2,
				children: [
					button("overview", "Overview", home, "1"),
					button("files", "Files", () => show($, "list", cwd), "2"),
					button(
						"refresh",
						"Refresh",
						async () => {
							await refresh($);
							if (view.kind !== "status") await show($, view.kind, view.directory, view.file, view.offset, view.layer);
						},
						"r",
					),
				],
			}),
			line(" "),
		];
		if (view.kind === "status") {
			children.push(line("SESSION", { bold: true, color: "cyan" }), line(model || "Model unavailable"), line(cwd));
			if (usage?.context?.percent !== undefined) children.push(line(`Context ${usage.context.percent}%`));
			if (usage?.context?.tokens !== undefined)
				children.push(line(`Context tokens ${usage.context.tokens.toLocaleString()}`));
			if (usage?.cost?.usd !== undefined) children.push(line(`Cost $${usage.cost.usd.toFixed(2)}`));
			for (const limit of usage?.rateLimits ?? []) children.push(line(`${limit.kind}: ${limit.percentUsed}% used`));
			children.push(line(" "), line("GIT", { bold: true, color: "cyan" }));
			if (status?.available) {
				const summary = status.summary;
				children.push(
					line(status.branch),
					line(`${summary.staged} staged · ${summary.unstaged} unstaged`),
					line(`${summary.untracked} untracked · ${summary.conflicted} conflicts`),
					line(" "),
					line("CHANGED FILES", { bold: true, color: "cyan" }),
					line("Repository-wide changes", { dimColor: true }),
				);
				for (const [i, file] of status.items.entries())
					children.push(
						button(`changed-${i}`, `${text(file.code)} ${text(file.path)}`, () =>
							show($, "diff", status.repository, file.path),
						),
					);
				if (!status.items.length) children.push(line("Working tree clean"));
				if (status.nextOffset !== null) children.push(line(`Showing ${status.items.length} of ${status.total} files`));
			} else children.push(line(error || status?.message || "Loading Git status…"));
		} else {
			children.push(line(view.file, { bold: true }), line(view.loading ? "Loading…" : view.error || " "));
			if (view.kind === "list" && view.result) {
				if (view.file !== ".") {
					const parent = view.file.replace(/[/\\][^/\\]+[/\\]?$/, "") || ".";
					children.push(
						button("parent", ".. parent folder", () =>
							show($, "list", view.directory, parent === view.file ? "." : parent),
						),
					);
				}
				for (const [i, file] of view.result.items.entries())
					children.push(
						button(`file-${i}`, `${file.type === "directory" ? "▸ " : "  "}${text(file.name)}`, () =>
							show($, file.type === "directory" ? "list" : "preview", view.directory, file.path),
						),
					);
				if (!view.result.items.length) children.push(line("This folder is empty."));
			} else if (view.result) {
				children.push(
					Box({
						flexDirection: "row",
						columnGap: 2,
						children: [
							button("preview", "File", () => show($, "preview", view.directory, view.file)),
							button("unstaged", "Unstaged", () => show($, "diff", view.directory, view.file)),
							button("staged", "Staged", () => show($, "diff", view.directory, view.file, 0, "staged")),
						],
					}),
				);
				if (view.result.comparison) children.push(line(view.result.comparison, { dimColor: true }));
				if (!view.result.items.length)
					children.push(line(view.kind === "diff" ? "No changes in this layer." : "This file is empty."));
				children.push(
					Code({
						source: view.result.items.map((item) => item.text).join("\n"),
						path: view.file,
						startLine: view.offset + 1,
						...(view.kind === "diff" ? { language: "diff" } : {}),
					}),
				);
			}
			if (view.result)
				children.push(
					Box({
						flexDirection: "row",
						columnGap: 2,
						children: [
							...(view.offset > 0
								? [
										button("previous", "Previous", () =>
											show($, view.kind, view.directory, view.file, Math.max(0, view.offset - 40), view.layer),
										),
									]
								: []),
							...(view.result.nextOffset !== null
								? [
										button("next", "Next", () =>
											show($, view.kind, view.directory, view.file, view.result.nextOffset, view.layer),
										),
									]
								: []),
						],
					}),
				);
		}
		children.push(line(" "), line("Tab/Enter navigate · Esc to prompt", { dimColor: true }));
		return Box({ flexDirection: "column", children });
	});
}
