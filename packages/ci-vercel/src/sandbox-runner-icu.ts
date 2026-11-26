import {
	beforeDeadline,
	collectVerifiedRunnerArchive,
} from "./sandbox-runner-archive.js";

// Ubuntu 26.04 (resolute) amd64 libicu78, published in Ubuntu's main archive.
// The exact version and digest are verified before the file reaches the VM.
// public-contract: bootstrap tests and operators can identify the fixed package source.
export const SANDBOX_ICU_URL =
	"https://snapshot.ubuntu.com/ubuntu/20260304T000000Z/pool/main/i/icu/libicu78_78.2-2ubuntu1_amd64.deb";
// public-contract: host and guest independently verify the same package digest.
export const SANDBOX_ICU_SHA256 =
	"c8b97930f9e365d6d00978144b468ac8397ef07d2fb2c453869f05fc3a98c4ca";
export const SANDBOX_ICU_BYTES = 11_456_466;

/** Fetch a fixed Ubuntu package without redirect or unbounded buffering. */
export async function downloadSandboxIcu(
	fetcher: typeof fetch = fetch,
): Promise<Buffer> {
	const signal = AbortSignal.timeout(60_000);
	const response = await beforeDeadline(
		fetcher(SANDBOX_ICU_URL, { redirect: "error", signal }),
		signal,
	);
	if (response.redirected) throw new Error("unexpected ICU redirect");
	let bytes: Buffer;
	try {
		bytes = await collectVerifiedRunnerArchive(
			response,
			SANDBOX_ICU_SHA256,
			SANDBOX_ICU_BYTES,
			signal,
		);
	} catch (error) {
		void response.body?.cancel().catch(() => {});
		throw error;
	}
	if (bytes.length !== SANDBOX_ICU_BYTES)
		throw new Error("ICU package size mismatch");
	return bytes;
}
