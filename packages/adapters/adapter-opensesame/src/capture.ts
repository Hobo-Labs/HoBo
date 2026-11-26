/**
 * The part of a long stream worth keeping for classification: the start (where
 * OpenSesame says a plugin is missing or a token has no sealed entry, before
 * the child exists) and the end (where it says a run was tripped, signalled or
 * refused). What a child printed in between is not read, so it is not held.
 */
export type Capture = {
	push(chunk: string): void;
	text(): string;
};

const GAP = "\n[... output omitted ...]\n";

export function createCapture(limit: number): Capture {
	let head = "";
	let tail = "";
	let dropped = false;
	return {
		push(chunk) {
			if (head.length < limit) {
				const room = limit - head.length;
				head += chunk.slice(0, room);
				chunk = chunk.slice(room);
			}
			if (chunk === "") return;
			tail += chunk;
			if (tail.length > limit) {
				tail = tail.slice(tail.length - limit);
				dropped = true;
			}
		},
		text() {
			return dropped ? `${head}${GAP}${tail}` : `${head}${tail}`;
		},
	};
}
