import { OpenSesameAdapterError } from "../../src/errors.js";

/** The typed refusal `run` throws, or `undefined` when it returns; anything else it throws is rethrown. */
export function refusalOf<T>(run: () => T): OpenSesameAdapterError | undefined {
	try {
		run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error;
		throw error;
	}
	return undefined;
}

/** As `refusalOf`, for a run that returns a promise. */
export async function refusalOfAsync<T>(
	run: () => Promise<T>,
): Promise<OpenSesameAdapterError | undefined> {
	try {
		await run();
	} catch (error) {
		if (error instanceof OpenSesameAdapterError) return error;
		throw error;
	}
	return undefined;
}
