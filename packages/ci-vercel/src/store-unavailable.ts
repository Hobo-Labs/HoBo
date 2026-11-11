/**
 * The store failed recently and is being left alone; `retryAfterMs` says for
 * how long.
 *
 * In a module of its own, with no imports: the bootstrap entry throws it, and
 * both the queue wakeup handler and the queue consumer's redelivery policy
 * read `retryAfterMs` from it without importing the application.
 */
export class StoreUnavailable extends Error {
	constructor(readonly retryAfterMs: number) {
		super("store unavailable; not retried yet");
		this.name = "StoreUnavailable";
	}
}
