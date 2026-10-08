import { homedir } from "node:os";
import path from "node:path";
import { Workspace, type WorkspaceIO, type WorkspaceSnapshot } from "./workspace-files.ts";

/** Handle quotes and ~ without a shell or changing the working folder. */
export function resolveExplorerFolder(input: string, root: string, home = homedir(), paths = path): string {
	let value = input.trim();
	if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
		value = value.slice(1, -1);
	if (value === "~") value = home;
	else if (value.startsWith("~/") || (paths.sep === "\\" && value.startsWith("~\\")))
		value = paths.join(home, value.slice(2));
	if (paths.sep === "\\" && /^[a-z]:$/i.test(value)) value += "\\";
	return paths.resolve(root, value);
}

function inside(relative: string, paths = path): boolean {
	return relative !== ".." && !relative.startsWith(`..${paths.sep}`) && !paths.isAbsolute(relative);
}

/** Use paths from the project root inside the project, and full paths outside it. */
export function explorerReference(project: string, root: string, file: string, paths = path): string {
	const absolute = paths.resolve(root, file);
	const relative = paths.relative(project, absolute);
	return inside(relative, paths) ? relative.split(paths.sep).join("/") : absolute;
}

/**
 * Keep one Git cache for the project and one folder cache for browsing elsewhere.
 * Only read the folder being opened. Do not scan Git in other projects.
 */
export class ExplorerLocation implements WorkspaceSnapshot {
	readonly project: Workspace;
	readonly projectRoot: string;
	private active: Workspace;
	private candidate: Workspace | undefined;
	private rootPath: string;
	private generation = 0;
	private disposed = false;
	private readonly onChange: (reset: boolean) => void;
	private readonly io: Partial<WorkspaceIO>;
	private changesCache: { source: ReadonlySet<string>; root: string; paths: ReadonlySet<string> } | undefined;

	constructor(root: string, onChange: (reset: boolean) => void, io: Partial<WorkspaceIO> = {}) {
		this.projectRoot = this.rootPath = path.resolve(root);
		this.onChange = onChange;
		this.io = io;
		this.project = this.active = new Workspace(this.projectRoot, () => this.onChange(false), io);
	}

	get root(): string {
		return this.rootPath;
	}

	children(dir: string) {
		return this.active.children(dir);
	}

	error(dir: string): string | undefined {
		return this.active.errors.get(dir);
	}

	private projectPath(file: string): string | undefined {
		if (this.active === this.project) return file;
		const relative = path.relative(this.projectRoot, path.resolve(this.root, file));
		return inside(relative) ? relative.split(path.sep).join("/") : undefined;
	}

	mark(file: string) {
		const relative = this.projectPath(file);
		return relative === undefined ? undefined : this.project.mark(relative);
	}

	containsMarks(dir: string): boolean {
		const relative = this.projectPath(dir);
		return relative !== undefined && this.project.containsMarks(relative);
	}

	isIgnored(file: string): boolean {
		const relative = this.projectPath(file);
		return relative === undefined ? this.active.isIgnored(file) : this.project.isIgnored(relative);
	}

	sessionChanges(source: ReadonlySet<string>): ReadonlySet<string> {
		if (this.active === this.project) return source;
		if (this.changesCache?.source === source && this.changesCache.root === this.root) return this.changesCache.paths;
		const paths = new Set<string>();
		for (const file of source) {
			const relative = path.relative(this.root, path.resolve(this.projectRoot, file));
			if (inside(relative)) paths.add(relative.split(path.sep).join("/"));
		}
		this.changesCache = { source, root: this.root, paths };
		return paths;
	}

	reference(file: string): string {
		return explorerReference(this.projectRoot, this.root, file);
	}

	async load(dir: string): Promise<void> {
		const workspace = this.active;
		await workspace.load(dir);
		if (this.disposed || workspace !== this.active) return;
		const error = workspace.errors.get(dir);
		if (error) throw new Error(error);
	}

	/** Use the last folder picked. If it cannot be opened, keep showing the current folder. */
	async go(input: string): Promise<boolean> {
		if (this.disposed) return false;
		const generation = ++this.generation;
		this.candidate?.dispose();
		this.candidate = undefined;
		const root = resolveExplorerFolder(input, this.root);
		if (path.relative(root, this.root) === "") return false;
		let next: Workspace;
		if (path.relative(root, this.projectRoot) === "") next = this.project;
		else {
			next = new Workspace(
				root,
				() => {
					if (this.active === next && !this.disposed) this.onChange(false);
				},
				{ ...this.io, prefix: async () => undefined },
			);
			this.candidate = next;
			await next.load("");
			if (this.disposed || generation !== this.generation) return false;
			this.candidate = undefined;
			const error = next.errors.get("");
			if (error) {
				next.dispose();
				throw new Error(error);
			}
		}
		if (this.active !== this.project) this.active.dispose();
		this.active = next;
		this.rootPath = root;
		this.changesCache = undefined;
		this.onChange(true);
		// Back at the project folder, show the saved list first, then reload it without a Git scan.
		if (next === this.project) void next.load("", true);
		return true;
	}

	async refresh(signal?: AbortSignal, directories: readonly string[] = [""]) {
		const active = this.active;
		const [snapshot] = await Promise.all([
			this.project.refresh(signal, active === this.project ? directories : []),
			active === this.project ? undefined : active.refresh(signal, directories),
		]);
		return snapshot;
	}

	dispose(): void {
		this.disposed = true;
		this.generation++;
		this.candidate?.dispose();
		if (this.active !== this.project) this.active.dispose();
		this.project.dispose();
	}
}
