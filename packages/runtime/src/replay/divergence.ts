import crypto from "node:crypto";
import { cloneAsJson } from "../json.js";
import { stableStringify } from "./equivalence.js";
import type { ReplayDivergenceRecord } from "./types.js";

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
	}) {
		super("replay/live materialization mismatch");
		this.name = "ReplayDivergenceError";
		this.liveState = input.liveState;
		this.replayState = input.replayState;
		this.liveOrder = input.liveOrder;
		this.replayOrder = input.replayOrder;
		this.firstDivergentEventKey =
			input.firstDivergentEventKey ??
			findFirstDivergentKey(input.liveOrder, input.replayOrder);
		this.divergence = {
			runId: input.runId,
			liveStateDigest: digest(input.liveState),
			replayStateDigest: digest(input.replayState),
			liveOrder: input.liveOrder,
			replayOrder: input.replayOrder,
			firstDivergentEventKey: this.firstDivergentEventKey,
		};
	}
}

export function digest<T>(value: T): string {
	return crypto
		.createHash("sha256")
		.update(stableStringify(cloneAsJson(value)))
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
