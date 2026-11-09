import { ResolverError } from "@hobo/core";

/** Parse the bounded native GET-script response without normalizing source
 * bytes. The uploaded contract is one ES module; extra modules are refused. */
export function parseCloudflareWorkerSource(
	body: string,
	contentType: string,
	mainModule: string,
): string {
	const media = contentType.split(";", 1)[0]?.trim().toLowerCase();
	if (
		[
			"application/javascript",
			"application/javascript+module",
			"text/javascript",
		].includes(media ?? "")
	)
		return body;
	const boundary =
		/^multipart\/form-data\s*;\s*boundary=(?:"([^"\r\n]+)"|([^;\s]+))\s*$/iu.exec(
			contentType,
		);
	const delimiter = boundary?.[1] ?? boundary?.[2];
	const invalid = () =>
		new ResolverError(
			"RESOLVER_OUTPUT_UNPARSEABLE",
			"Cloudflare Worker content did not match the approved single-module multipart contract",
		);
	if (
		!delimiter ||
		!/^[A-Za-z0-9'()+_,./:=?-]{1,70}$/u.test(delimiter) ||
		!body.startsWith(`--${delimiter}\r\n`)
	)
		throw invalid();
	const parts = body.slice(delimiter.length + 4).split(`\r\n--${delimiter}`);
	if (parts.length !== 2 || !["--\r\n", "--"].includes(parts[1] ?? ""))
		throw invalid();
	const module = parts[0] ?? "",
		split = module.indexOf("\r\n\r\n");
	if (split < 0 || split > 8192) throw invalid();
	const headers = module.slice(0, split).split("\r\n"),
		dispositions = headers.filter((header) =>
			/^content-disposition:/iu.test(header),
		);
	if (dispositions.length !== 1) throw invalid();
	const names = [
		...(dispositions[0] ?? "").matchAll(
			/(?:^|;)\s*name=(?:"([^"\r\n]*)"|([^;\s]+))/giu,
		),
	];
	if (names.length !== 1 || (names[0]?.[1] ?? names[0]?.[2]) !== mainModule)
		throw invalid();
	return module.slice(split + 4);
}
