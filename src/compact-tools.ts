import type { AgentToolResult, Theme, ToolRenderers } from "@earendil-works/pi-coding-agent";
import {
	Box,
	type Component,
	Container,
	getCapabilities,
	imageFallback,
	stripTerminalSequences,
	Text,
	type TuiMouseEvent,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";

type RenderCall = NonNullable<ToolRenderers["renderCall"]>;
type RenderResult = NonNullable<ToolRenderers["renderResult"]>;
type RenderContext = Parameters<RenderCall>[2];
type Args = Record<string, unknown>;
const STATE = Symbol("midnight.compact");
const COMMAND_TOOLS = new Set(["bash", "powershell"]);
const EMPTY: Component = { render: () => [], invalidate() {} };
// Keep big results from making the first expand slow.
const MAX_FORMAT_CHARS = 256 * 1024;
const COMMAND_RESULT_KEYS = new Set(["output", "truncated", "full_output_path", "exit_code", "wall_time_seconds"]);

/** Use one timer. Clear its callbacks when the session changes. */
class RenderClock {
	generation = 0;
	private readonly rows = new Map<CompactRow, () => void>();
	private timer: NodeJS.Timeout | undefined;

	watch(row: CompactRow, invalidate?: () => void): void {
		if (invalidate) this.rows.set(row, invalidate);
		else this.rows.delete(row);
		if (this.rows.size && !this.timer) {
			this.timer = setInterval(() => {
				for (const callback of [...this.rows.values()]) callback();
			}, 1000);
			this.timer.unref?.();
		} else if (!this.rows.size) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}

	reset(): void {
		clearInterval(this.timer);
		this.timer = undefined;
		this.rows.clear();
		this.generation++;
	}
}

/** Cleanup is safe to call more than once, including after a reload. */
export function compactToolRenderers(enabled: () => boolean) {
	const clock = new RenderClock();
	const resolver = (toolName: string, next: () => ToolRenderers | undefined): ToolRenderers => {
		const base = next();
		const row = (context: RenderContext) => {
			const shared = context.state as { [STATE]?: CompactRow };
			shared[STATE] ??= new CompactRow(toolName, base, enabled, clock);
			return shared[STATE];
		};
		const renderCall: RenderCall = (args, theme, context) => {
			const component = row(context);
			component.updateCall((args ?? {}) as Args, theme, context);
			return component;
		};
		const renderResult: RenderResult = (result, _options, theme, context) => {
			const component = row(context);
			// HTML exports can ask for the result before the call.
			const standalone = !component.matchesCall(context);
			if (standalone) component.updateCall((context.args ?? {}) as Args, theme, context);
			component.updateResult(result);
			return standalone ? component : EMPTY;
		};
		// This row draws the call, result, and Pi's usual box when needed.
		return { renderShell: "self", renderCall, renderResult };
	};
	return Object.assign(resolver, { dispose: () => clock.reset() });
}

class CompactRow implements Component {
	private readonly name: string;
	private readonly base: ToolRenderers | undefined;
	private readonly enabled: () => boolean;
	private readonly clock: RenderClock;
	private readonly generation: number;
	private args: Args = {};
	private theme!: Theme;
	private context!: RenderContext;
	private result: AgentToolResult<unknown> | undefined;
	private resultContent: AgentToolResult<unknown>["content"] | undefined;
	private resultDetails: unknown;
	private expandedOutput:
		| { source: AgentToolResult<unknown>["content"]; content: AgentToolResult<unknown>["content"] }
		| undefined;
	private outcome = "";
	private reason = "";
	private described = { active: "", done: "", detail: "" as string | undefined };
	private command = "";
	private startedAt: number | undefined;
	private callComponent: Component | undefined;
	private resultComponent: Component | undefined;
	private normal: Component | undefined;
	private cache: { width: number; lines: string[] } | undefined;

	constructor(name: string, base: ToolRenderers | undefined, enabled: () => boolean, clock: RenderClock) {
		this.name = name;
		this.base = base;
		this.enabled = enabled;
		this.clock = clock;
		this.generation = clock.generation;
	}

	updateCall(args: Args, theme: Theme, context: RenderContext): void {
		if (this.args !== args || !context.argsComplete || !this.context?.argsComplete) {
			this.described = { detail: undefined, ...describe(this.name, args) };
			this.command = COMMAND_TOOLS.has(this.name) ? firstLine(str(args.command)) : "";
		}
		this.args = args;
		this.theme = theme;
		this.context = context;
		const running = context.isPartial && context.executionStarted;
		if (running) this.startedAt ??= Date.now();
		if (this.generation === this.clock.generation)
			this.clock.watch(this, running && this.compact() ? context.invalidate : undefined);
		this.cache = undefined;
		this.normal = undefined;
	}

	updateResult(result: AgentToolResult<unknown>): void {
		this.result = result;
		if (this.expandedOutput?.source !== result.content) this.expandedOutput = undefined;
		// Pi may create a new result object even when its content and details are the same.
		if (!this.context.isPartial && (result.content !== this.resultContent || result.details !== this.resultDetails)) {
			this.resultContent = result.content;
			this.resultDetails = result.details;
			this.outcome = outcomeOf(this.name, result);
			this.reason = lastLine(textOf(result));
		}
		this.cache = undefined;
		this.normal = undefined;
	}

	matchesCall(context: RenderContext): boolean {
		return (
			this.context?.isPartial === context.isPartial &&
			this.context.expanded === context.expanded &&
			this.context.isError === context.isError
		);
	}

	handleMouse(event: TuiMouseEvent) {
		return this.compact() ? undefined : this.normal?.handleMouse?.(event);
	}

	private compact(): boolean {
		return this.enabled() && !this.context.expanded;
	}

	invalidate(): void {
		this.cache = undefined;
		this.normal = undefined;
		this.callComponent?.invalidate();
		this.resultComponent?.invalidate();
	}

	render(width: number): string[] {
		if (this.cache?.width === width) return this.cache.lines;
		const compact = this.compact();
		const lines = compact ? this.summary(width) : this.renderNormal(width);
		// Pi already wraps these lines. Only trim lines that are too wide.
		this.cache = {
			width,
			lines: lines.map((line) => (!compact && visibleWidth(line) <= width ? line : truncateToWidth(line, width))),
		};
		return this.cache.lines;
	}

	private summary(width: number): string[] {
		const theme = this.theme;
		const context = this.context;
		const { active, done, detail } = this.described;
		if (context.isPartial) {
			const elapsed = this.startedAt === undefined ? 0 : Math.floor((Date.now() - this.startedAt) / 1000);
			const title = theme.fg("toolTitle", theme.bold(active));
			const lines = [elapsed > 0 ? `${title}${theme.fg("dim", ` · ${elapsed}s`)}` : title];
			if (this.command)
				lines.push(theme.fg("dim", `  └ $ ${truncateToWidth(this.command, Math.max(1, width - 6), "…")}`));
			return lines;
		}
		if (context.isError)
			return [theme.fg("error", `✗ ${done}`) + (this.reason ? theme.fg("dim", ` · ${this.reason}`) : "")];
		const suffix = [detail, this.outcome].filter(Boolean).join(" · ");
		return [theme.fg("muted", done) + (suffix ? theme.fg("dim", ` · ${suffix}`) : "")];
	}

	private displayResult(result: AgentToolResult<unknown>): AgentToolResult<unknown> {
		if (this.name !== "codemode" || !this.enabled() || !this.context.expanded || this.context.isPartial) return result;
		// Cache text without colors. Pi can change the result details without changing the text.
		this.expandedOutput ??= { source: result.content, content: formatCodemodeOutput(result.content) };
		return this.expandedOutput.content === result.content
			? result
			: { ...result, content: this.expandedOutput.content };
	}

	private renderNormal(width: number): string[] {
		if (!this.normal) {
			const theme = this.theme;
			const context = this.context;
			this.callComponent =
				tryRenderer(() =>
					this.base?.renderCall?.(this.args, theme, { ...context, lastComponent: this.callComponent }),
				) ??
				new Text(`${theme.bold(theme.fg("toolTitle", this.name))}\n${clean(JSON.stringify(this.args, null, 2))}`, 0, 0);
			if (this.result) {
				const result = this.displayResult(this.result);
				this.resultComponent =
					tryRenderer(() =>
						this.base?.renderResult?.(result, { expanded: context.expanded, isPartial: context.isPartial }, theme, {
							...context,
							lastComponent: this.resultComponent,
						}),
					) ?? new Text(theme.fg("toolOutput", fallbackOutput(result, context.expanded, context.showImages)), 0, 0);
			}
			const shell =
				this.base?.renderShell === "self"
					? new Container()
					: new Box(1, 1, (text) =>
							theme.bg(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg", text),
						);
			shell.addChild(this.callComponent);
			if (this.result && this.resultComponent) shell.addChild(this.resultComponent);
			this.normal = shell;
		}
		return this.normal.render(width);
	}
}

/** Only change the display. Keep headers, images, unknown data, and saved/model results as they are. */
function formatCodemodeOutput(content: AgentToolResult<unknown>["content"]): AgentToolResult<unknown>["content"] {
	let budget = MAX_FORMAT_CHARS;
	let changed = false;
	const formatted = content.map((part) => {
		if (part.type !== "text") return part;
		const text = part.text;
		budget -= text.length;
		if (budget < 0 || !text.includes('"output"') || !text.includes('"exit_code"')) return part;
		// Codemode's text(object) gives us JSON. Leave other text, code, and paths alone.
		const lines = text.split("\n");
		let replaced = false;
		for (let i = 0; i < lines.length; i++) {
			const output = formatCommandResult(lines[i]);
			if (output === undefined) continue;
			lines[i] = output;
			replaced = true;
		}
		if (!replaced) return part;
		changed = true;
		return { ...part, text: lines.join("\n") };
	});
	return changed ? formatted : content;
}

function formatCommandResult(line: string): string | undefined {
	const json = line.trim();
	if (!json.startsWith("{") || !json.endsWith("}") || !json.includes('"output"') || !json.includes('"exit_code"'))
		return undefined;
	let value: Record<string, unknown>;
	try {
		value = JSON.parse(json);
	} catch {
		return undefined;
	}
	// Only format this known JSON shape so no extra fields get lost.
	if (
		typeof value.output !== "string" ||
		typeof value.truncated !== "boolean" ||
		!Number.isInteger(value.exit_code) ||
		typeof value.wall_time_seconds !== "number" ||
		!Number.isFinite(value.wall_time_seconds) ||
		value.wall_time_seconds < 0 ||
		(value.full_output_path !== undefined && typeof value.full_output_path !== "string") ||
		Object.keys(value).some((key) => !COMMAND_RESULT_KEYS.has(key))
	)
		return undefined;
	const output = clean(value.output.replace(/\r\n/g, "\n"));
	const status = `Exit code: ${value.exit_code} · ${value.wall_time_seconds}s${value.truncated ? " · Output truncated" : ""}`;
	const path = typeof value.full_output_path === "string" ? `\nFull output: ${clean(value.full_output_path)}` : "";
	return `${output}${output ? (output.endsWith("\n") ? "\n" : "\n\n") : ""}${status}${path}`;
}

function tryRenderer(render: () => Component | undefined): Component | undefined {
	try {
		return render();
	} catch {
		return undefined;
	}
}

function describe(name: string, args: Args): { active: string; done: string; detail?: string } {
	const path = clean(str(args.path) || str(args.file_path)).replace(/\s+/g, " ");
	switch (name) {
		case "bash":
		case "powershell":
			return { active: "Running shell command", done: "Ran shell command", detail: firstLine(str(args.command)) };
		case "read": {
			const offset = num(args.offset);
			const limit = num(args.limit);
			const range = offset || limit ? `:${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : ""}` : "";
			return { active: `Reading ${path}`, done: `Read ${path}${range}` };
		}
		case "edit":
			return { active: `Editing ${path}`, done: `Edited ${path}` };
		case "write":
			return { active: `Writing ${path}`, done: `Wrote ${path}` };
		case "grep":
			return { active: "Searching", done: "Searched", detail: `/${firstLine(str(args.pattern))}/${scope(args)}` };
		case "find":
			return { active: "Finding files", done: "Found files", detail: `${firstLine(str(args.pattern))}${scope(args)}` };
		case "ls":
			return { active: `Listing ${path || "."}`, done: `Listed ${path || "."}` };
		default:
			return { active: `Calling ${clean(name)}`, done: `Called ${clean(name)}` };
	}
}

function outcomeOf(name: string, result: AgentToolResult<unknown>): string {
	if (name === "write") return "";
	if (name === "edit") {
		const diff = (result.details as { diff?: unknown } | undefined)?.diff;
		if (typeof diff !== "string") return "";
		let added = 0;
		let removed = 0;
		for (let i = 0; i < diff.length; i++) {
			if (i && diff.charCodeAt(i - 1) !== 10) continue;
			if (diff[i] === "+") added++;
			else if (diff[i] === "-") removed++;
		}
		return `+${added} −${removed}`;
	}
	const text = textOf(result).trim();
	let lines = text ? 1 : 0;
	for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1)) lines++;
	switch (name) {
		case "read":
			return result.content.some((part) => part.type === "image") ? "image" : plural(lines, "line");
		case "grep":
			return text === "No matches found" ? "no matches" : plural(lines, "match", "matches");
		case "find":
			return text.startsWith("No files found") ? "no files" : plural(lines, "file");
		case "ls":
			return text === "(empty directory)" ? "empty" : plural(lines, "entry", "entries");
		default:
			return lines > 1 ? plural(lines, "line") : "";
	}
}

function textOf(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

function fallbackOutput(result: AgentToolResult<unknown>, expanded: boolean, showImages: boolean): string {
	let text = clean(textOf(result));
	if (!showImages || !getCapabilities().images) {
		const images = result.content
			.filter((part) => part.type === "image")
			.map((part) => imageFallback(part.mimeType))
			.join("\n");
		if (images) text += `${text ? "\n" : ""}${images}`;
	}
	if (expanded) return text;
	const lines = text.split("\n");
	return lines.length > 10
		? `${lines.slice(0, 10).join("\n")}\n... (${lines.length - 10} more lines, Ctrl+O to expand)`
		: text;
}

function scope(args: Args): string {
	const path = firstLine(str(args.path));
	const glob = firstLine(str(args.glob));
	return `${path && path !== "." ? ` in ${path}` : ""}${glob ? ` (${glob})` : ""}`;
}

function clean(text: string): string {
	return stripTerminalSequences(text).replace(/\p{Cc}/gu, (char) => (char === "\n" || char === "\t" ? char : ""));
}

function firstLine(text: string): string {
	const trimmed = text.trim();
	const end = trimmed.indexOf("\n");
	return clean(end < 0 ? trimmed : `${trimmed.slice(0, end)} …`).replace(/\t/g, " ");
}

function lastLine(text: string): string {
	const trimmed = text.trim();
	return firstLine(trimmed.slice(trimmed.lastIndexOf("\n") + 1));
}

function plural(count: number, one: string, many = `${one}s`): string {
	return `${count} ${count === 1 ? one : many}`;
}
const str = (value: unknown): string => (typeof value === "string" ? value : "");
const num = (value: unknown): number | undefined => (typeof value === "number" ? value : undefined);
