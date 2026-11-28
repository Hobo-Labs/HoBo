/* oxlint-disable anti-slop/no-unknown-returns -- SAFETY: provider-specific callers validate this bounded, untrusted JSON at their own response boundaries. */

export async function readBoundedJsonResponse(
	response: Response,
): Promise<unknown> {
	const maximum = 2 * 1024 * 1024;
	const declared = Number(response.headers.get("content-length") ?? "0");
	if (!Number.isFinite(declared) || declared < 0 || declared > maximum)
		throw new Error("response too large");
	if (response.body === null) throw new Error("empty response");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const next = await reader.read();
			if (next.done) break;
			bytes += next.value.byteLength;
			if (bytes > maximum) throw new Error("response too large");
			chunks.push(next.value);
		}
	} finally {
		await reader.cancel().catch(() => {});
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
