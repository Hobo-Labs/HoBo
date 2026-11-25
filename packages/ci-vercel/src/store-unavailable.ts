export class StoreUnavailable extends Error {
	constructor(readonly retryAfterMs: number) {
		super("store unavailable; not retried yet");
		this.name = "StoreUnavailable";
	}
}
