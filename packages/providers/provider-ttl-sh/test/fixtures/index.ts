/**
 * Offline fixtures. Nothing here reaches the network, and every identifier is
 * obviously fake: a fixed UUID and repeating-hex digests.
 */
import {
	type ProcessResult,
	type ProcessRunner,
	type TransportRequest,
	type TransportResponse,
	type TtlShErrorCode,
	TtlShProviderError,
	type TtlShTransport,
} from "../../src/index.js";

// Hex letters on purpose: an all-digit UUID would make the uppercase-refusal
// test vacuous, because upper-casing it changes nothing.
export const FAKE_UUID_NAME = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const FAKE_DIGEST = `sha256:${"a1".repeat(32)}`;
export const OTHER_DIGEST = `sha256:${"b2".repeat(32)}`;
export const FAKE_CONTENT_NAME = `sha256-${"a1".repeat(32)}`;
export const FAKE_PULL_REFERENCE = `ttl.sh/${FAKE_UUID_NAME}:1h`;

/** A credential that must never appear in an argv, a header, or a receipt. */
export const LEAKED_TOKEN = "ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE00000000";

export const NOW_MS = Date.parse("2026-08-08T12:00:00.000Z");

export type StubResponse = {
	readonly status: number;
	readonly headers?: Readonly<Record<string, string>>;
	readonly body?: string;
};

export type StubTransport = TtlShTransport & {
	readonly requests: readonly TransportRequest[];
};

export function expectTtlShCode(
	run: () => void,
	code: TtlShErrorCode,
): TtlShProviderError {
	try {
		run();
	} catch (error) {
		if (error instanceof TtlShProviderError && error.code === code) {
			return error;
		}
		throw error;
	}
	throw new Error(`expected TtlShProviderError ${code}`);
}

export function expectTtlShProviderError(run: () => void): TtlShProviderError {
	try {
		run();
	} catch (error) {
		if (error instanceof TtlShProviderError) return error;
		throw error;
	}
	throw new Error("expected TtlShProviderError");
}

export async function rejectTtlShCode(
	run: () => Promise<object | undefined>,
	code: TtlShErrorCode,
): Promise<TtlShProviderError> {
	try {
		await run();
	} catch (error) {
		if (error instanceof TtlShProviderError && error.code === code) {
			return error;
		}
		throw error;
	}
	throw new Error(`expected TtlShProviderError ${code}`);
}

export function createStubTransport(options: {
	readonly script?: readonly StubResponse[];
	readonly throws?: readonly Error[];
}): StubTransport {
	const requests: TransportRequest[] = [];
	const script = [...(options.script ?? [{ status: 200, body: "{}" }])];
	const throws = [...(options.throws ?? [])];
	return {
		requests,
		async request(request): Promise<TransportResponse> {
			requests.push(request);
			const failure = throws.shift();
			if (failure !== undefined) throw failure;
			// The last scripted response repeats, so a test only lists the
			// responses whose order it actually cares about.
			const next = (script.length > 1 ? script.shift() : script[0]) ?? {
				status: 200,
				body: "{}",
			};
			return {
				status: next.status,
				headers: next.headers ?? {},
				body: next.body ?? "",
			};
		},
	};
}

export type StubRunner = ProcessRunner & {
	readonly invocations: readonly {
		readonly argv: readonly string[];
		readonly env: Readonly<Record<string, string>>;
	}[];
};

export function createStubRunner(options: {
	readonly results?: readonly ProcessResult[];
	readonly throws?: readonly Error[];
}): StubRunner {
	const invocations: {
		argv: readonly string[];
		env: Readonly<Record<string, string>>;
	}[] = [];
	const results = [...(options.results ?? [])];
	const throws = [...(options.throws ?? [])];
	return {
		invocations,
		async run(argv, runOptions) {
			invocations.push({ argv, env: runOptions.env });
			const failure = throws.shift();
			if (failure !== undefined) throw failure;
			return (
				results.shift() ?? {
					code: 0,
					stdout: `${FAKE_DIGEST}\n`,
					stderr: "",
				}
			);
		},
	};
}
