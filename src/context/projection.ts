import { digestMessages } from "./context-document.ts";
import type { ContextEditTrace, LiveContextMessage } from "./types.ts";

export const PROJECTION_PREFIX_MISMATCH_REASON = "Raw context prefix no longer matches the projection checkpoint.";

export interface ProjectionCheckpoint {
	version: 1;
	revision: number;
	sourceMessageCount: number;
	sourceDigest: string;
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit?: "characters" | "tokens";
	createdAt: string;
	editTrace?: ContextEditTrace;
}

export type ProjectionApplication =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
	  }
	| {
			valid: false;
			messages: LiveContextMessage[];
			reason: string;
	  };

export type ProjectionRecovery =
	| {
			valid: true;
			messages: LiveContextMessage[];
			suffix: LiveContextMessage[];
			removedErrorCount: number;
			anchorRevision?: number;
	  }
	| {
			valid: false;
			reason: string;
	  };

function isPersistedRetryError(message: LiveContextMessage): boolean {
	return message.role === "assistant" && message.stopReason === "error";
}

export function createProjectionCheckpoint(options: {
	revision: number;
	sourceMessages: LiveContextMessage[];
	projectedMessages: LiveContextMessage[];
	beforeEstimate: number;
	afterEstimate: number;
	estimateUnit?: "characters" | "tokens";
	createdAt?: string;
	editTrace?: ContextEditTrace;
}): ProjectionCheckpoint {
	const checkpoint: ProjectionCheckpoint = {
		version: 1,
		revision: options.revision,
		sourceMessageCount: options.sourceMessages.length,
		sourceDigest: digestMessages(options.sourceMessages),
		projectedMessages: [...options.projectedMessages],
		beforeEstimate: options.beforeEstimate,
		afterEstimate: options.afterEstimate,
		estimateUnit: options.estimateUnit,
		createdAt: options.createdAt ?? new Date().toISOString(),
		editTrace: options.editTrace,
	};

	JSON.stringify(checkpoint);
	return checkpoint;
}

export function applyProjection(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint | undefined,
): ProjectionApplication {
	if (!checkpoint) {
		return { valid: true, messages: [...rawMessages], suffix: [] };
	}
	if (checkpoint.version !== 1) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: `Unsupported projection version: ${checkpoint.version}.`,
		};
	}
	if (rawMessages.length < checkpoint.sourceMessageCount) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: "Raw context is shorter than the projection source prefix.",
		};
	}

	const sourcePrefix = rawMessages.slice(0, checkpoint.sourceMessageCount);
	if (digestMessages(sourcePrefix) !== checkpoint.sourceDigest) {
		return {
			valid: false,
			messages: [...rawMessages],
			reason: PROJECTION_PREFIX_MISMATCH_REASON,
		};
	}

	const suffix = rawMessages.slice(checkpoint.sourceMessageCount);
	return {
		valid: true,
		messages: [...checkpoint.projectedMessages, ...suffix],
		suffix,
	};
}

export function recoverProjectionFromRetryErrors(
	rawMessages: LiveContextMessage[],
	checkpoint: ProjectionCheckpoint,
	history: ProjectionCheckpoint[] = [],
): ProjectionRecovery {
	const direct = applyProjection(rawMessages, checkpoint);
	if (direct.valid) {
		return {
			...direct,
			removedErrorCount: 0,
		};
	}

	const candidates: Array<{ sourceMessageCount: number; sourceDigest?: string; revision?: number }> = [
		...history
			.filter(
				(candidate) =>
					candidate.revision < checkpoint.revision &&
					candidate.sourceMessageCount <= checkpoint.sourceMessageCount &&
					rawMessages.length >= candidate.sourceMessageCount,
			)
			.sort((left, right) => right.sourceMessageCount - left.sourceMessageCount)
			.map((anchor) => ({
				sourceMessageCount: anchor.sourceMessageCount,
				sourceDigest: anchor.sourceDigest,
				revision: anchor.revision,
			})),
		{ sourceMessageCount: 0 },
	];
	const seenCounts = new Set<number>();

	for (const anchor of candidates) {
		if (seenCounts.has(anchor.sourceMessageCount)) continue;
		seenCounts.add(anchor.sourceMessageCount);
		const prefix = rawMessages.slice(0, anchor.sourceMessageCount);
		if (anchor.sourceDigest && digestMessages(prefix) !== anchor.sourceDigest) continue;
		const retainedSourceTail: LiveContextMessage[] = [];
		let cursor = anchor.sourceMessageCount;
		let removedErrorCount = 0;
		while (prefix.length + retainedSourceTail.length < checkpoint.sourceMessageCount && cursor < rawMessages.length) {
			const message = rawMessages[cursor++];
			if (isPersistedRetryError(message)) removedErrorCount += 1;
			else retainedSourceTail.push(message);
		}
		if (removedErrorCount === 0) continue;

		const candidateMessages = [...prefix, ...retainedSourceTail, ...rawMessages.slice(cursor)];
		const recovered = applyProjection(candidateMessages, checkpoint);
		if (!recovered.valid) continue;
		return {
			...recovered,
			removedErrorCount,
			anchorRevision: anchor.revision,
		};
	}

	return {
		valid: false,
		reason: direct.reason,
	};
}
