export class PulumiEngineUnavailableError extends Error {
	code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "PulumiEngineUnavailableError";
		this.code = code;
	}
}
