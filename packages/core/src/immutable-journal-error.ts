export class ImmutableJournalError extends Error {
	constructor(readonly reason: string) {
		super(`immutable journal ${reason}`);
		this.name = "ImmutableJournalError";
	}
}
