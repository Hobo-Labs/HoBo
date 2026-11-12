// Server-sent events codec for the delivery feed (WHATWG HTML §9.2). Pure.
//
//   frame      `id: <position>\nevent: frame\ndata: <DeliveryFeedFrame JSON>\n\n`
//   heartbeat  `: heartbeat\n\n` (a comment; carries no id)
//   end        `event: end\ndata: {"reason":"caught-up"|"long-poll"|"limit"}\n\n`
//
// A response without a trailing `end` event was cut off; the client resumes
// with `Last-Event-ID` set to the last frame id it received, so nothing is
// skipped and nothing is repeated.

// public-contract: SSE event names of the delivery feed.
export const FEED_SSE_EVENTS = Object.freeze({ frame: "frame", end: "end" } as const);

// public-contract: reasons a feed response ends cleanly.
export const FEED_END_REASONS = Object.freeze(["caught-up", "long-poll", "limit"] as const);
export type FeedEndReason = (typeof FEED_END_REASONS)[number];

export type SseMessage = Readonly<{ id?: string; event: string; data: string }>;

export function encodeFrame(id: string, json: string): string {
	return `id: ${id}\nevent: ${FEED_SSE_EVENTS.frame}\ndata: ${json}\n\n`;
}

export function encodeHeartbeat(): string {
	return ": heartbeat\n\n";
}

export function encodeEnd(reason: FeedEndReason): string {
	return `event: ${FEED_SSE_EVENTS.end}\ndata: ${JSON.stringify({ reason })}\n\n`;
}

/** Parse complete SSE messages; a trailing partial message is dropped (it was cut off). */
export function decodeSse(text: string): readonly SseMessage[] {
	const out: SseMessage[] = [];
	const blocks = text.replace(/\r\n?/gu, "\n").split("\n\n");
	// The last block is complete only if the text ended with a blank line.
	blocks.pop();
	for (const block of blocks) {
		let id: string | undefined;
		let event = "message";
		const data: string[] = [];
		for (const line of block.split("\n")) {
			if (line === "" || line.startsWith(":")) continue;
			const colon = line.indexOf(":");
			const field = colon === -1 ? line : line.slice(0, colon);
			const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /u, "");
			if (field === "id") id = value;
			else if (field === "event") event = value;
			else if (field === "data") data.push(value);
		}
		if (data.length === 0) continue;
		out.push(id === undefined ? { event, data: data.join("\n") } : { id, event, data: data.join("\n") });
	}
	return out;
}
