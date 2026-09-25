import { join } from "node:path";
import { lazyStream } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/compat";
import { type Static, Type } from "typebox";
import type { ExtensionAPI, ExtensionFactory } from "../core/extensions/types.ts";
import type { EngineManager } from "./engine-manager.ts";
import {
	createHelperTask,
	formatHelperResult,
	GIT_OPS,
	HELPER_KINDS,
	type HelperResult,
	runHelperTask,
} from "./helper.ts";
import { getMidnightHome } from "./paths.ts";
import { LOCAL_MODEL_ID, LOCAL_PROVIDER_ID } from "./pins.ts";

/**
 * Register the engine as the `midnight` provider. Each request gets the engine
 * from the manager, which starts it on first use and again after an idle stop,
 * and sends to that engine's current URL and key. With `localOnly`, every model
 * request in the session is restricted to it. The restriction lives in the model
 * runtime, so selecting another model later fails instead of sending data out.
 */
export function createLocalProviderExtension(
	manager: EngineManager,
	options: { localOnly: boolean; contextSize: number },
): ExtensionFactory {
	const completions = openAICompletionsApi();
	return (pi: ExtensionAPI) => {
		pi.registerProvider(LOCAL_PROVIDER_ID, {
			name: "midnight.server local",
			// Placeholders: streamSimple replaces both with the running engine's values.
			baseUrl: "http://127.0.0.1/v1",
			apiKey: "local",
			api: "openai-completions",
			streamSimple: (model, context, streamOptions) =>
				lazyStream(model, async () => {
					const engine = await manager.get(streamOptions?.signal);
					return completions.streamSimple({ ...model, baseUrl: `${engine.baseUrl}/v1` }, context, {
						...streamOptions,
						apiKey: engine.apiKey,
					});
				}),
			models: [
				{
					id: LOCAL_MODEL_ID,
					name: "MiniCPM5-2B Q8_0 (local)",
					reasoning: true,
					thinkingLevelMap: { off: "off", minimal: null, low: null, medium: "medium", high: null, xhigh: null },
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: options.contextSize,
					maxTokens: Math.floor(options.contextSize / 2),
					compat: {
						supportsStore: false,
						supportsDeveloperRole: false,
						supportsReasoningEffort: false,
						supportsUsageInStreaming: true,
						supportsStrictMode: false,
						maxTokensField: "max_tokens",
						thinkingFormat: "qwen-chat-template",
					},
				},
			],
		});
		if (options.localOnly) {
			pi.on("session_start", (_event, ctx) => {
				ctx.modelRegistry.restrictRequestProviders([LOCAL_PROVIDER_ID]);
			});
		}
	};
}

const delegateParameters = Type.Object({
	kind: Type.Union(
		HELPER_KINDS.map((kind) => Type.Literal(kind)),
		{
			description:
				"summarize | classify | inspect (answer a question about files) | plan (short step list) | patch (propose exact edits; never applied)",
		},
	),
	instruction: Type.String({ description: "The bounded task for the local helper, stated completely." }),
	paths: Type.Optional(
		Type.Array(Type.String(), {
			description:
				"Workspace files the helper may read (at most 8). It sees nothing else. Omit for a git-only task.",
			maxItems: 8,
		}),
	),
	context: Type.Optional(
		Type.String({
			description: "Extra data such as test output or search results (max 8000 chars).",
			maxLength: 8000,
		}),
	),
	git: Type.Optional(
		Type.Object(
			{
				op: Type.Union(
					GIT_OPS.map((op) => Type.Literal(op)),
					{
						description:
							"status | diff (working tree changes) | log (recent commits) | show (one commit) | blame (line authorship, needs exactly one path)",
					},
				),
				ref: Type.Optional(
					Type.String({ description: "A single ref or 'a..b' / 'a...b' range. Meaning depends on op." }),
				),
				staged: Type.Optional(Type.Boolean({ description: "diff only: equivalent to git diff --staged." })),
				maxCount: Type.Optional(Type.Integer({ description: "log only: number of commits (1-50, default 10)." })),
				paths: Type.Optional(
					Type.Array(Type.String(), { description: "Workspace-relative pathspecs. blame requires exactly one." }),
				),
			},
			{ description: "Run one read-only git operation and include its output as additional context. No shell." },
		),
	),
});

/**
 * `delegate_local`: a parent model hands a bounded, read-only job to the local
 * MiniCPM helper. The helper gets only the named workspace files, has no tools,
 * and returns a validated result. Patch proposals are returned, not applied.
 */
export function createDelegateExtension(manager: EngineManager): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		pi.registerTool({
			name: "delegate_local",
			label: "delegate_local",
			description:
				"Delegate a small, well-defined task to the on-device MiniCPM5-2B helper. It reads only the files you list (inside the workspace), cannot run tools or edit files, and returns a summary with line evidence and checks. It can also run one read-only git operation (status/diff/log/show/blame) itself and include the output, without you needing to run git first. Use it for summaries, classification, focused questions about a few files or a diff, short plans, and small patch proposals. Verify its output before acting on it; patches are proposals you must apply yourself.",
			promptSnippet: "Delegate small read-only tasks (including read-only git ops) to the local MiniCPM helper",
			promptGuidelines: [
				"delegate_local runs on this machine; its answers can be wrong. Check evidence before relying on them.",
				"Keep delegate_local tasks small: at most a few files and one clear question.",
				"git is read-only and whitelisted (status/diff/log/show/blame); it can't commit, push, or otherwise mutate the repo.",
			],
			parameters: delegateParameters,
			executionMode: "sequential",
			async execute(toolCallId, params: Static<typeof delegateParameters>, signal, onUpdate, ctx) {
				onUpdate?.({ content: [{ type: "text", text: "Starting local helper..." }], details: undefined });
				const engine = await manager.get(signal);
				onUpdate?.({
					content: [{ type: "text", text: `Local helper running ${params.kind} task...` }],
					details: undefined,
				});
				const task = createHelperTask({
					parentId: toolCallId,
					kind: params.kind,
					instruction: params.instruction,
					workspaceRoot: ctx.cwd,
					paths: params.paths ?? [],
					context: params.context,
					git: params.git,
				});
				const result: HelperResult = await runHelperTask(engine, task, {
					signal,
					artifactDir: join(getMidnightHome(), "artifacts"),
				});
				manager.touch();
				if (result.status === "failed") throw new Error(formatHelperResult(result));
				return { content: [{ type: "text", text: formatHelperResult(result) }], details: result };
			},
		});
	};
}
