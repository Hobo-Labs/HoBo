import crypto from "node:crypto";
import { cloneAsJson } from "../json.js";
import { isNonEmptyPrimitiveString } from "../workflow-boundary.js";
import { canonicalizationVersion } from "./canonicalization.js";
import { stableStringifyForVersion } from "./equivalence.js";
import type {
	CanonicalizationVersion,
	ReplayDivergenceRecord,
} from "./types.js";

export class ReplayDivergenceError extends Error {
	readonly liveState: unknown;
	readonly replayState: unknown;
	readonly liveOrder: string[];
	readonly replayOrder: string[];
	readonly firstDivergentEventKey: string;
	readonly divergence: ReplayDivergenceRecord;

	constructor(input: {
		runId: string;
		liveState: unknown;
		replayState: unknown;
		liveOrder: string[];
		replayOrder: string[];
		firstDivergentEventKey?: string;
		canonicalizationVersion?: CanonicalizationVersion;
	}) {
		super("replay/live materialization mismatch");
		if (!isNonEmptyPrimitiveString(input.runId))
			throw new TypeError("replay runId must be a non-empty string");
		const version = canonicalizationVersion(input.canonicalizationVersion, 2);
		const liveOrder = [...input.liveOrder];
		const replayOrder = [...input.replayOrder];
		this.name = "ReplayDivergenceError";
		this.liveState = input.liveState;
		this.replayState = input.replayState;
		this.liveOrder = [...liveOrder];
		this.replayOrder = [...replayOrder];
		this.firstDivergentEventKey =
			input.firstDivergentEventKey ??
			findFirstDivergentKey(liveOrder, replayOrder);
		this.divergence = Object.freeze({
			canonicalizationVersion: version,
			runId: input.runId,
			liveStateDigest: digestForVersion(input.liveState, version),
			replayStateDigest: digestForVersion(input.replayState, version),
			liveOrder: Object.freeze(liveOrder),
			replayOrder: Object.freeze(replayOrder),
			firstDivergentEventKey: this.firstDivergentEventKey,
		});
	}
}

export function digest<T>(value: T): string {
	return digestForVersion(value, 2);
}

export function digestForVersion<T>(
	value: T,
	version: CanonicalizationVersion,
): string {
	return crypto
		.createHash("sha256")
		.update(stableStringifyForVersion(cloneAsJson(value), version))
		.digest("hex");
}

function findFirstDivergentKey(
	liveOrder: string[],
	replayOrder: string[],
): string {
	const max = Math.max(liveOrder.length, replayOrder.length);
	for (let index = 0; index < max; index += 1) {
		if (liveOrder[index] !== replayOrder[index]) {
			return liveOrder[index] ?? replayOrder[index] ?? "unknown";
		}
	}
	return liveOrder[0] ?? replayOrder[0] ?? "unknown";
}
