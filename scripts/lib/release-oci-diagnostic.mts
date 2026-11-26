export function ociRegistryFailure(message: string): string | undefined {
	const status =
		/^(HEAD manifest|GET manifest|HEAD blob|GET blob|upload blob|upload chunk of|close upload of|PUT manifest|GET referrers of|DELETE) [a-zA-Z0-9_.:+-]{1,256} answered HTTP ([1-5][0-9]{2})(?: \([A-Z_, ]{1,256}\))?$/u.exec(
			message,
		);
	if (status) return `oci operation=${status[1]} http=${status[2]}`;
	const upload =
		/^start blob upload answered HTTP ([1-5][0-9]{2})(?: \([A-Z_, ]{1,256}\))?$/u.exec(
			message,
		);
	if (upload) return `oci operation=start blob upload http=${upload[1]}`;
	const auth =
		/^token realm for registry ghcr\.io answered HTTP ([1-5][0-9]{2})$/u.exec(
			message,
		);
	if (auth) return `oci operation=token exchange http=${auth[1]}`;
	if (
		/^blob sha256:[0-9a-f]{64} is [0-9]+ bytes, over the [0-9]+-byte transport bound$/u.test(
			message,
		)
	)
		return "oci blob-too-large";
	if (
		/^registry transport failed(?: \(TRANSPORT_[A-Z_]+\))?; nothing past the last observation is assumed$/u.test(
			message,
		)
	)
		return "oci transport-failed";
	return undefined;
}
