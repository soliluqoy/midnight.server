export type LiveContextMessage = {
	role: string;
	content?: unknown;
	timestamp?: number;
	[key: string]: unknown;
};

export interface DocumentBlock {
	index: number;
	id: string;
	role: string;
	protected: boolean;
	header: string;
	body: string;
	source: LiveContextMessage;
}

export interface ContextDocumentSnapshot {
	version: 1;
	revision: number;
	baselineDigest: string;
	documentId: string;
	stableDocument?: boolean;
	text: string;
	messages: LiveContextMessage[];
	blocks: DocumentBlock[];
}

export interface TurnBaseline {
	rawMessages: LiveContextMessage[];
	effectiveMessages: LiveContextMessage[];
	snapshot: ContextDocumentSnapshot;
}

export interface ApplyDocumentOptions {
	editingMode?: "conservative" | "clm";
	requireShrink?: boolean;
	minSavings?: number;
	estimate?: (messages: LiveContextMessage[]) => number;
	estimateUnit?: "characters" | "tokens";
}

export type ContextEditSourceKind = "kept" | "edited" | "removed" | "restored" | "normalized";

export interface ContextEditSourceTrace {
	sourceIndex: number;
	outputIndex?: number;
	kind: ContextEditSourceKind;
}

export interface ContextEditAdditionTrace {
	outputIndex: number;
	kind: "added";
}

export interface ContextEditTrace {
	version: 1;
	sourceRevision: number;
	sourceMessageCount: number;
	outputMessageCount: number;
	sources: ContextEditSourceTrace[];
	additions: ContextEditAdditionTrace[];
}

export interface ApplyDocumentResult {
	accepted: boolean;
	changed: boolean;
	messages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	savingsEstimate: number;
	diagnostics: string[];
	editTrace?: ContextEditTrace;
	reason?: string;
}
