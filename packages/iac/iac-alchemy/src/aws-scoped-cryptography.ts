import {
	type CryptographyOutcome,
	type CryptographyPort,
	type CryptographyRequest,
	parseCryptographyRequest,
} from "@hobo/core/cryptography";

const freeze = Object.freeze;
const setPrototype = Object.setPrototypeOf;
function outcome<T extends CryptographyOutcome>(value: T): T {
	setPrototype(value, null);
	return freeze(value);
}
export function scopeAwsCryptography(
	port: CryptographyPort,
	live: () => boolean,
): CryptographyPort {
	const permitted = () => {
		try {
			return live() === true;
		} catch {
			return false;
		}
	};
	const perform = async (
		operation: "encrypt" | "decrypt",
		input: CryptographyRequest,
	): Promise<CryptographyOutcome> => {
		let request: CryptographyRequest;
		try {
			request = parseCryptographyRequest(input);
		} catch {
			return outcome({ status: "rejected", code: "invalid-argument" });
		}
		if (!permitted())
			return outcome({ status: "rejected", code: "unauthorized" });
		try {
			const result = await port[operation](request);
			return permitted()
				? result
				: outcome({ status: "unknown", attemptId: request.attemptId });
		} catch {
			return outcome({ status: "unknown", attemptId: request.attemptId });
		}
	};
	return freeze({
		encrypt: (input: CryptographyRequest) => perform("encrypt", input),
		decrypt: (input: CryptographyRequest) => perform("decrypt", input),
	});
}
