import { createHash } from "node:crypto";

// public-contract: bootstrap and its contract tests share the pinned runner version.
export const SANDBOX_RUNNER_VERSION = "2.338.2";
// public-contract: both host and sandbox verify the same pinned release digest.
export const SANDBOX_RUNNER_SHA256 =
	"baebf204307bac6193480852732f0aba2ae97b6c5597c244f4d5558390147c40";
export const SANDBOX_RUNNER_MAX_BYTES = 256 * 1024 * 1024;
// public-contract: archive verification tests pin the official release URL.
export const SANDBOX_RUNNER_URL = `https://github.com/actions/runner/releases/download/v${SANDBOX_RUNNER_VERSION}/actions-runner-linux-x64-${SANDBOX_RUNNER_VERSION}.tar.gz`;
const allowedDownloadHosts = new Set([
	"github.com",
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
]);

export async function beforeDeadline<T>(
	operation: Promise<T>,
	signal: AbortSignal,
): Promise<T> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const abort = () => reject(new Error("runner download timed out"));
		signal.addEventListener("abort", abort, { once: true });
		operation.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			() => {
				signal.removeEventListener("abort", abort);
				reject(new Error("runner download failed"));
			},
		);
	});
}

/** Read a bounded stream and validate its full digest before returning bytes. */
export async function collectVerifiedRunnerArchive(
	response: Response,
	expectedSha256: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<Buffer> {
	if (
		!/^[a-f0-9]{64}$/.test(expectedSha256) ||
		!Number.isSafeInteger(maxBytes) ||
		maxBytes < 1 ||
		maxBytes > SANDBOX_RUNNER_MAX_BYTES
	)
		throw new Error("invalid archive verification parameters");
	if (!response.ok || !response.body) throw new Error("runner download failed");
	const declared = response.headers.get("content-length");
	if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxBytes))
		throw new Error("runner archive too large");
	const encoding = response.headers.get("content-encoding");
	if (encoding && encoding.toLowerCase() !== "identity")
		throw new Error("runner archive encoding unsupported");
	const reader = response.body.getReader();
	const hash = createHash("sha256");
	const chunks: Buffer[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await beforeDeadline(reader.read(), signal);
			if (done) break;
			size += value.byteLength;
			if (size > maxBytes) throw new Error("runner archive too large");
			hash.update(value);
			chunks.push(Buffer.from(value));
		}
		if (
			(declared && Number(declared) !== size) ||
			hash.digest("hex") !== expectedSha256
		)
			throw new Error("runner archive checksum mismatch");
		return Buffer.concat(chunks, size);
	} catch (error) {
		void reader.cancel().catch(() => {});
		throw error;
	} finally {
		reader.releaseLock();
	}
}

/** The release URL, digest, redirect hosts, size and deadline are not user configurable. */
export async function downloadSandboxRunner(
	fetcher: typeof fetch = fetch,
): Promise<Buffer> {
	const signal = AbortSignal.timeout(120_000);
	let url = new URL(SANDBOX_RUNNER_URL);
	for (let redirects = 0; redirects <= 5; redirects++) {
		const response = await beforeDeadline(
			fetcher(url, { redirect: "manual", signal }),
			signal,
		);
		if (response.redirected)
			throw new Error("unexpected automatic runner redirect");
		if (response.status >= 300 && response.status < 400) {
			const location = response.headers.get("location");
			void response.body?.cancel().catch(() => {});
			if (!location || redirects === 5)
				throw new Error("invalid runner redirect");
			const next = new URL(location, url);
			if (
				next.protocol !== "https:" ||
				next.username ||
				next.password ||
				next.port ||
				!allowedDownloadHosts.has(next.hostname)
			)
				throw new Error("untrusted runner redirect");
			url = next;
			continue;
		}
		return collectVerifiedRunnerArchive(
			response,
			SANDBOX_RUNNER_SHA256,
			SANDBOX_RUNNER_MAX_BYTES,
			signal,
		);
	}
	throw new Error("runner download failed");
}
