const reviewed = new Map([
	[
		"process@0.10.1",
		"MIT: the published package includes its MIT LICENSE; https://registry.npmjs.org/process/-/process-0.10.1.tgz",
	],
	[
		"vbare@0.0.4",
		"MIT: its release workspace declares MIT and identifies the vbare package; https://github.com/rivet-dev/vbare/blob/2425888196f6f7b9eb1b1b5f14550f6ee50f93cd/typescript/package.json",
	],
]);

export function reviewedLicense(
	name: string,
	version: string,
): string | undefined {
	return reviewed.get(`${name}@${version}`);
}
