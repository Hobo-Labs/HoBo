import * as tls from "node:tls";

type CertificateSource = "default" | "bundled" | "extra";

export function snapshotDefaultTrust(
	read: ((source: CertificateSource) => readonly string[]) | undefined,
	nodeVersion = process.versions.node,
): readonly string[] {
	if (!read)
		throw new Error(
			"This Node runtime cannot inspect its effective TLS trust.",
		);
	const [majorText, minorText] = nodeVersion.split(".");
	const major = Number(majorText);
	const minor = Number(minorText);
	if (
		!/^\d+\.\d+\.\d+$/u.test(nodeVersion) ||
		!Number.isSafeInteger(major) ||
		!Number.isSafeInteger(minor) ||
		!(
			(major === 22 && minor >= 15) ||
			(major === 23 && minor >= 10) ||
			major === 24
		)
	)
		throw new Error(
			"This Node runtime has not been verified for effective TLS trust.",
		);
	const effective = read("default");
	const bundled = read("bundled");
	const extra = read("extra");
	const counts = new Map<string, number>();
	for (const certificate of effective)
		counts.set(certificate, (counts.get(certificate) ?? 0) + 1);
	if (bundled.length === 0)
		throw new Error("This Node runtime cannot verify its effective TLS trust.");
	for (const certificate of [...bundled, ...extra]) {
		const count = counts.get(certificate) ?? 0;
		if (count === 0)
			throw new Error(
				"This Node runtime cannot verify its effective TLS trust.",
			);
		counts.set(certificate, count - 1);
	}
	return effective;
}

export function defaultCaCertificates(): readonly string[] {
	return snapshotDefaultTrust(tls.getCACertificates?.bind(undefined));
}
