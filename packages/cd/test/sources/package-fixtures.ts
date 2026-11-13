// Recorded registry exchanges for every package ecosystem.
import { createHash } from "node:crypto";
import { latin1Text } from "../../src/sources/json.js";
import { type Exchange, json } from "./support.js";

export const tarball = new Uint8Array([
	0x1f, 0x8b, 0x08, 0x00, 0xff, 0x80, 0x00, 0x7f,
]);
export const tarballBody = latin1Text(tarball);
export const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

/** Recorded registry exchanges for every package ecosystem. */
export const PACKAGE_FIXTURES: readonly Exchange[] = [
	{
		url: "https://registry.npmjs.org/@acme%2fweb",
		response: json({
			name: "@acme/web",
			versions: {
				"1.0.0": {
					dist: {
						tarball: "https://registry.npmjs.org/@acme/web/-/web-1.0.0.tgz",
						integrity,
					},
				},
				"1.1.0-rc.1": {
					dist: {
						tarball:
							"https://registry.npmjs.org/@acme/web/-/web-1.1.0-rc.1.tgz",
						integrity,
					},
				},
			},
		}),
	},
	{
		url: "https://registry.npmjs.org/@acme/web/-/web-1.0.0.tgz",
		response: tarballBody,
	},
	{
		url: "https://pypi.org/pypi/acme-web/json",
		response: json({
			releases: {
				"2.0.0": [
					{
						filename: "acme_web-2.0.0-py3-none-any.whl",
						url: "https://files.pythonhosted.org/a.whl",
						packagetype: "bdist_wheel",
						digests: { sha256: "1".repeat(64) },
					},
					{
						filename: "acme-web-2.0.0.tar.gz",
						url: "https://files.pythonhosted.org/a.tar.gz",
						packagetype: "sdist",
						digests: { sha256: "2".repeat(64) },
					},
				],
				"2.1.0": [
					{
						filename: "acme-web-2.1.0.tar.gz",
						url: "https://files.pythonhosted.org/b.tar.gz",
						packagetype: "sdist",
						yanked: true,
						digests: { sha256: "3".repeat(64) },
					},
				],
			},
		}),
	},
	{
		url: "https://index.crates.io/ac/me/acme-web",
		response: [
			json({
				name: "acme-web",
				vers: "0.1.0",
				cksum: "4".repeat(64),
				yanked: false,
			}),
			json({
				name: "acme-web",
				vers: "0.2.0",
				cksum: "5".repeat(64),
				yanked: true,
			}),
		].join("\n"),
	},
	{
		url: "https://rubygems.org/api/v1/versions/acme-web.json",
		response: json([
			{ number: "3.0.0", sha: "6".repeat(64), platform: "ruby" },
			{ number: "3.0.0", sha: "7".repeat(64), platform: "java" },
		]),
	},
	{
		url: "https://api.nuget.org/v3-flatcontainer/acme.web/index.json",
		response: json({ versions: ["4.0.0"] }),
	},
	{
		url: "https://api.nuget.org/v3-flatcontainer/acme.web/4.0.0/acme.web.4.0.0.nupkg",
		response: tarballBody,
	},
	{
		url: "https://repo1.maven.org/maven2/com/acme/web/maven-metadata.xml",
		response:
			"<metadata><versioning><versions><version>5.0.0</version><version>5.1.0</version></versions></versioning></metadata>",
	},
	{
		url: "https://repo1.maven.org/maven2/com/acme/web/5.0.0/web-5.0.0.jar.sha256",
		response: `${"8".repeat(64)}\n`,
	},
	{
		url: "https://repo1.maven.org/maven2/com/acme/web/5.1.0/web-5.1.0.jar.sha256",
		status: 404,
	},
	{
		url: "https://repo1.maven.org/maven2/com/acme/web/5.1.0/web-5.1.0.jar",
		response: tarballBody,
	},
];
