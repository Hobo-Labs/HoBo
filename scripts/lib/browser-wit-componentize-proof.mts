import path from "node:path";

export type BrowserWitComponentizeProof = Readonly<{
	workRoot: string;
	componentDigest: `sha256:${string}`;
	finishedAt: string;
}>;

export function parseBrowserWitComponentizeProof(
	raw: string,
): BrowserWitComponentizeProof {
	let parsed: {
		workRoot?: string;
		componentDigest?: string;
		finishedAt?: string;
	};
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("componentize proof is not valid JSON");
	}
	if (
		Object.prototype.toString.call(parsed) !== "[object Object]" ||
		parsed === null
	) {
		throw new Error("componentize proof must be a JSON object");
	}
	const workRootRaw = parsed.workRoot;
	if (Object.prototype.toString.call(workRootRaw) !== "[object String]") {
		throw new Error("componentize proof workRoot is invalid");
	}
	const workRoot = workRootRaw as string;
	if (
		workRoot.length === 0 ||
		!workRoot.includes(path.join(".cache", "browser-wit-componentize"))
	) {
		throw new Error("componentize proof workRoot is invalid");
	}
	const digestRaw = parsed.componentDigest;
	if (Object.prototype.toString.call(digestRaw) !== "[object String]") {
		throw new Error("componentize proof componentDigest is invalid");
	}
	const componentDigest = digestRaw as string;
	if (!/^sha256:[0-9a-f]{64}$/u.test(componentDigest)) {
		throw new Error("componentize proof componentDigest is invalid");
	}
	const finishedAtRaw = parsed.finishedAt;
	if (Object.prototype.toString.call(finishedAtRaw) !== "[object String]") {
		throw new Error("componentize proof finishedAt is missing");
	}
	const finishedAt = finishedAtRaw as string;
	if (finishedAt.length === 0) {
		throw new Error("componentize proof finishedAt is missing");
	}
	return {
		workRoot,
		componentDigest: componentDigest as `sha256:${string}`,
		finishedAt,
	};
}
