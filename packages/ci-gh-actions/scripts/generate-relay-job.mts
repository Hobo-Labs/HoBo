#!/usr/bin/env node
/**
 * Generates `src/_generated-assets/relay-job-assets.ts`: the two files
 * `hobo ci init --relay` writes into a repository for the relay job's job
 * mode (ADR-0183).
 *
 * - `.github/workflows/hobo-relay.yml`, copied from `templates/hobo-relay.yml`.
 * - `.hobo-ci/relay.mjs`, the evaluator: `src/relay-job/main.ts` and the
 *   engine it calls bundled into one readable ES module, with the licenses of
 *   the third-party code inside it, under a header naming the source commit
 *   and the SHA-256 of everything after the header.
 *
 * `--check` fails when the committed asset is not what the sources make. The
 * source commit is not compared: it is kept from the committed asset while
 * the evaluator's body is unchanged, and is the current commit otherwise.
 *
 * Usage: node --import tsx scripts/generate-relay-job.mts [--check]
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
export const RELAY_JOB_ASSET_PATH = resolve(
	PACKAGE_ROOT,
	"src/_generated-assets/relay-job-assets.ts",
);
const TEMPLATE_PATH = resolve(PACKAGE_ROOT, "templates/hobo-relay.yml");
const ENTRY_DIRECTORY = resolve(PACKAGE_ROOT, "src/relay-job");
const SOURCE_PATH = "packages/ci-gh-actions/src/relay-job/main.ts";
const HEADER_END = "// --- end of header ---\n";

/** The few lines that run the entry; `main.ts` itself only exports. */
const ENTRY = `import { runRelayJobCli } from "./main.ts";
process.exitCode = await runRelayJobCli({
	argv: process.argv.slice(2),
	env: new Map(Object.entries(process.env).filter((entry) => entry[1] !== undefined)),
	print: (line) => console.log(line),
	fetch: globalThis.fetch,
	nowMs: Date.now(),
	cwd: process.cwd(),
});
`;

export function sha256(text: string): string {
	return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * `@bufbuild/protobuf` ships no license file. Its license is the repository's
 * (bufbuild/protobuf-es at v2.12.1, `LICENSE`, read on 2026-11-17), and its
 * wire code derived from Google's protobuf keeps that code's BSD-3-Clause
 * notice, read at generation from the file that carries it.
 */
const BUFBUILD_PROTOBUF_LICENSE = `                                 Apache License
                           Version 2.0, January 2004
                        http://www.apache.org/licenses/

   TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION

   1. Definitions.

      "License" shall mean the terms and conditions for use, reproduction,
      and distribution as defined by Sections 1 through 9 of this document.

      "Licensor" shall mean the copyright owner or entity authorized by
      the copyright owner that is granting the License.

      "Legal Entity" shall mean the union of the acting entity and all
      other entities that control, are controlled by, or are under common
      control with that entity. For the purposes of this definition,
      "control" means (i) the power, direct or indirect, to cause the
      direction or management of such entity, whether by contract or
      otherwise, or (ii) ownership of fifty percent (50%) or more of the
      outstanding shares, or (iii) beneficial ownership of such entity.

      "You" (or "Your") shall mean an individual or Legal Entity
      exercising permissions granted by this License.

      "Source" form shall mean the preferred form for making modifications,
      including but not limited to software source code, documentation
      source, and configuration files.

      "Object" form shall mean any form resulting from mechanical
      transformation or translation of a Source form, including but
      not limited to compiled object code, generated documentation,
      and conversions to other media types.

      "Work" shall mean the work of authorship, whether in Source or
      Object form, made available under the License, as indicated by a
      copyright notice that is included in or attached to the work
      (an example is provided in the Appendix below).

      "Derivative Works" shall mean any work, whether in Source or Object
      form, that is based on (or derived from) the Work and for which the
      editorial revisions, annotations, elaborations, or other modifications
      represent, as a whole, an original work of authorship. For the purposes
      of this License, Derivative Works shall not include works that remain
      separable from, or merely link (or bind by name) to the interfaces of,
      the Work and Derivative Works thereof.

      "Contribution" shall mean any work of authorship, including
      the original version of the Work and any modifications or additions
      to that Work or Derivative Works thereof, that is intentionally
      submitted to Licensor for inclusion in the Work by the copyright owner
      or by an individual or Legal Entity authorized to submit on behalf of
      the copyright owner. For the purposes of this definition, "submitted"
      means any form of electronic, verbal, or written communication sent
      to the Licensor or its representatives, including but not limited to
      communication on electronic mailing lists, source code control systems,
      and issue tracking systems that are managed by, or on behalf of, the
      Licensor for the purpose of discussing and improving the Work, but
      excluding communication that is conspicuously marked or otherwise
      designated in writing by the copyright owner as "Not a Contribution."

      "Contributor" shall mean Licensor and any individual or Legal Entity
      on behalf of whom a Contribution has been received by Licensor and
      subsequently incorporated within the Work.

   2. Grant of Copyright License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      copyright license to reproduce, prepare Derivative Works of,
      publicly display, publicly perform, sublicense, and distribute the
      Work and such Derivative Works in Source or Object form.

   3. Grant of Patent License. Subject to the terms and conditions of
      this License, each Contributor hereby grants to You a perpetual,
      worldwide, non-exclusive, no-charge, royalty-free, irrevocable
      (except as stated in this section) patent license to make, have made,
      use, offer to sell, sell, import, and otherwise transfer the Work,
      where such license applies only to those patent claims licensable
      by such Contributor that are necessarily infringed by their
      Contribution(s) alone or by combination of their Contribution(s)
      with the Work to which such Contribution(s) was submitted. If You
      institute patent litigation against any entity (including a
      cross-claim or counterclaim in a lawsuit) alleging that the Work
      or a Contribution incorporated within the Work constitutes direct
      or contributory patent infringement, then any patent licenses
      granted to You under this License for that Work shall terminate
      as of the date such litigation is filed.

   4. Redistribution. You may reproduce and distribute copies of the
      Work or Derivative Works thereof in any medium, with or without
      modifications, and in Source or Object form, provided that You
      meet the following conditions:

      (a) You must give any other recipients of the Work or
          Derivative Works a copy of this License; and

      (b) You must cause any modified files to carry prominent notices
          stating that You changed the files; and

      (c) You must retain, in the Source form of any Derivative Works
          that You distribute, all copyright, patent, trademark, and
          attribution notices from the Source form of the Work,
          excluding those notices that do not pertain to any part of
          the Derivative Works; and

      (d) If the Work includes a "NOTICE" text file as part of its
          distribution, then any Derivative Works that You distribute must
          include a readable copy of the attribution notices contained
          within such NOTICE file, excluding those notices that do not
          pertain to any part of the Derivative Works, in at least one
          of the following places: within a NOTICE text file distributed
          as part of the Derivative Works; within the Source form or
          documentation, if provided along with the Derivative Works; or,
          within a display generated by the Derivative Works, if and
          wherever such third-party notices normally appear. The contents
          of the NOTICE file are for informational purposes only and
          do not modify the License. You may add Your own attribution
          notices within Derivative Works that You distribute, alongside
          or as an addendum to the NOTICE text from the Work, provided
          that such additional attribution notices cannot be construed
          as modifying the License.

      You may add Your own copyright statement to Your modifications and
      may provide additional or different license terms and conditions
      for use, reproduction, or distribution of Your modifications, or
      for any such Derivative Works as a whole, provided Your use,
      reproduction, and distribution of the Work otherwise complies with
      the conditions stated in this License.

   5. Submission of Contributions. Unless You explicitly state otherwise,
      any Contribution intentionally submitted for inclusion in the Work
      by You to the Licensor shall be under the terms and conditions of
      this License, without any additional terms or conditions.
      Notwithstanding the above, nothing herein shall supersede or modify
      the terms of any separate license agreement you may have executed
      with Licensor regarding such Contributions.

   6. Trademarks. This License does not grant permission to use the trade
      names, trademarks, service marks, or product names of the Licensor,
      except as required for reasonable and customary use in describing the
      origin of the Work and reproducing the content of the NOTICE file.

   7. Disclaimer of Warranty. Unless required by applicable law or
      agreed to in writing, Licensor provides the Work (and each
      Contributor provides its Contributions) on an "AS IS" BASIS,
      WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or
      implied, including, without limitation, any warranties or conditions
      of TITLE, NON-INFRINGEMENT, MERCHANTABILITY, or FITNESS FOR A
      PARTICULAR PURPOSE. You are solely responsible for determining the
      appropriateness of using or redistributing the Work and assume any
      risks associated with Your exercise of permissions under this License.

   8. Limitation of Liability. In no event and under no legal theory,
      whether in tort (including negligence), contract, or otherwise,
      unless required by applicable law (such as deliberate and grossly
      negligent acts) or agreed to in writing, shall any Contributor be
      liable to You for damages, including any direct, indirect, special,
      incidental, or consequential damages of any character arising as a
      result of this License or out of the use or inability to use the
      Work (including but not limited to damages for loss of goodwill,
      work stoppage, computer failure or malfunction, or any and all
      other commercial damages or losses), even if such Contributor
      has been advised of the possibility of such damages.

   9. Accepting Warranty or Additional Liability. While redistributing
      the Work or Derivative Works thereof, You may choose to offer,
      and charge a fee for, acceptance of support, warranty, indemnity,
      or other liability obligations and/or rights consistent with this
      License. However, in accepting such obligations, You may act only
      on Your own behalf and on Your sole responsibility, not on behalf
      of any other Contributor, and only if You agree to indemnify,
      defend, and hold each Contributor harmless for any liability
      incurred by, or claims asserted against, such Contributor by reason
      of your accepting any such warranty or additional liability.

   END OF TERMS AND CONDITIONS

   APPENDIX: How to apply the Apache License to your work.

      To apply the Apache License to your work, attach the following
      boilerplate notice, with the fields enclosed by brackets "[]"
      replaced with your own identifying information. (Don't include
      the brackets!)  The text should be enclosed in the appropriate
      comment syntax for the file format. We also recommend that a
      file or class name and description of purpose be included on the
      same "printed page" as the copyright notice for easier
      identification within third-party archives.

   Copyright 2021-2026 Buf Technologies, Inc.

   Licensed under the Apache License, Version 2.0 (the "License");
   you may not use this file except in compliance with the License.
   You may obtain a copy of the License at

       http://www.apache.org/licenses/LICENSE-2.0

   Unless required by applicable law or agreed to in writing, software
   distributed under the License is distributed on an "AS IS" BASIS,
   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
   See the License for the specific language governing permissions and
   limitations under the License.`;

/** The license text of a package that ships none, or undefined. */
async function shippedElsewhere(
	name: string,
	root: string,
): Promise<string | undefined> {
	if (name !== "@bufbuild/protobuf") return undefined;
	const derived = await readFile(`${root}/dist/esm/wire/varint.js`, "utf8");
	const lines = derived.split("\n");
	const end = lines.findIndex((line) => !line.startsWith("//"));
	const google = lines
		.slice(0, end < 0 ? lines.length : end)
		.map((line) => line.replace(/^\/\/ ?/u, ""))
		.join("\n")
		.trim();
	if (!google.startsWith("Copyright 2008 Google Inc."))
		throw new Error("the protobuf BSD notice moved; read it again");
	return `${BUFBUILD_PROTOBUF_LICENSE}\n\nParts are derived from Protocol Buffers, under this notice:\n\n${google}`;
}

/** The license notice of every third-party package the bundle holds. */
async function licenseNotice(inputs: readonly string[]): Promise<string> {
	const roots = new Set<string>();
	for (const input of inputs) {
		const marker = "/node_modules/";
		const index = input.lastIndexOf(marker);
		if (index < 0) continue;
		const base = input.slice(0, index + marker.length);
		const parts = input.slice(index + marker.length).split("/");
		const name = parts[0]?.startsWith("@")
			? parts.slice(0, 2).join("/")
			: parts[0];
		if (!name) throw new Error(`cannot name the package of ${input}`);
		roots.add(resolve(PACKAGE_ROOT, base, name));
	}
	const notices: string[] = [];
	for (const root of [...roots].sort()) {
		const manifest: { name: string; version: string; license?: string } =
			JSON.parse(await readFile(`${root}/package.json`, "utf8"));
		const file = ["LICENSE", "LICENSE.md", "LICENSE.txt"]
			.map((name) => `${root}/${name}`)
			.find((path) => existsSync(path));
		const text = file
			? (await readFile(file, "utf8")).trim()
			: await shippedElsewhere(manifest.name, root);
		if (!text) throw new Error(`no license file in ${manifest.name}`);
		notices.push(`${manifest.name}@${manifest.version}\n\n${text}`);
	}
	return `/*\n * Third-party code in this file, with its licenses:\n\n${notices
		.join("\n\n")
		.replaceAll("*/", "* /")}\n*/\n`;
}

/**
 * The workspace packages declare no `sideEffects`, so a bundler keeps every
 * module a barrel names. Their modules only define things, so each is marked
 * free of side effects and dropped unless the evaluator uses it.
 */
const sideEffectFree: Plugin = {
	name: "hobo-workspace-side-effect-free",
	setup(builder) {
		builder.onResolve({ filter: /^@hobo\// }, async (args) => {
			if (args.pluginData === "resolved") return undefined;
			const resolved = await builder.resolve(args.path, {
				kind: args.kind,
				importer: args.importer,
				resolveDir: args.resolveDir,
				pluginData: "resolved",
			});
			return { ...resolved, sideEffects: false };
		});
		builder.onResolve({ filter: /^\.\.?\// }, async (args) => {
			if (args.pluginData === "resolved" || args.importer === "")
				return undefined;
			// zod re-exports every message locale as `z.locales`; the evaluator
			// speaks English only, which zod configures itself from `en.js`.
			const path =
				args.importer.includes("/node_modules/zod/") &&
				args.path === "../locales/index.js"
					? "../locales/en.js"
					: args.path;
			const resolved = await builder.resolve(path, {
				kind: args.kind,
				importer: args.importer,
				resolveDir: args.resolveDir,
				pluginData: "resolved",
			});
			return resolved.path.includes("/node_modules/")
				? resolved
				: { ...resolved, sideEffects: false };
		});
	},
};

/** The evaluator's body: the license notice and the bundle. */
export async function relayEvaluatorBody(): Promise<string> {
	const result = await build({
		stdin: {
			contents: ENTRY,
			resolveDir: ENTRY_DIRECTORY,
			sourcefile: "relay-entry.ts",
			loader: "ts",
		},
		absWorkingDir: PACKAGE_ROOT,
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node20",
		write: false,
		metafile: true,
		minify: false,
		legalComments: "none",
		charset: "utf8",
		logLevel: "silent",
		plugins: [sideEffectFree],
	});
	const output = result.outputFiles[0];
	if (!output) throw new Error("esbuild produced no evaluator");
	return `${await licenseNotice(Object.keys(result.metafile.inputs))}${output.text}`;
}

/** The evaluator as written into a repository: header, then body. */
export function relayEvaluatorText(body: string, commit: string): string {
	return (
		[
			"// .hobo-ci/relay.mjs: the HoBo relay job's job-mode evaluator (ADR-0183).",
			"// Generated; do not edit. `hobo ci init --relay` writes it, and a check",
			"// compares the SHA-256 below with everything after this header.",
			`// Source: ${SOURCE_PATH}, generated at commit ${commit}.`,
			"// HoBo is MIT licensed; the third-party code below keeps its own licenses.",
			`// sha256: ${sha256(body)}`,
			HEADER_END,
		].join("\n") + body
	);
}

/** The body of an evaluator text, or undefined when its header is not one. */
export function relayEvaluatorBodyOf(text: string): string | undefined {
	const end = text.indexOf(HEADER_END);
	return end < 0 ? undefined : text.slice(end + HEADER_END.length);
}

/**
 * A string literal with every character outside ASCII escaped: the formatter
 * the asset passes through rewrites some of them when they are written out.
 */
function literal(text: string): string {
	return JSON.stringify(text).replace(
		/[^ -~]/g,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);
}

function formatted(source: string): string {
	return execFileSync(
		process.execPath,
		[
			createRequire(import.meta.url).resolve("@biomejs/biome/bin/biome"),
			"format",
			`--stdin-file-path=${RELAY_JOB_ASSET_PATH}`,
		],
		{ cwd: REPOSITORY_ROOT, input: source, encoding: "utf8" },
	);
}

/** The asset module for these sources, formatted as committed. */
export async function relayJobAssetSource(commit: string): Promise<string> {
	const workflow = await readFile(TEMPLATE_PATH, "utf8");
	const body = await relayEvaluatorBody();
	const evaluator = relayEvaluatorText(body, commit);
	return formatted(
		[
			"// Generated by scripts/generate-relay-job.mts. Do not edit.",
			"",
			"/** `.github/workflows/hobo-relay.yml`, from `templates/hobo-relay.yml`. */",
			`export const RELAY_JOB_WORKFLOW = ${literal(workflow)};`,
			`export const RELAY_JOB_WORKFLOW_SHA256 = ${JSON.stringify(sha256(workflow))};`,
			"/** `.hobo-ci/relay.mjs`: the job-mode evaluator, header and body. */",
			`export const RELAY_JOB_EVALUATOR = ${literal(evaluator)};`,
			"/** The SHA-256 of the evaluator's body, as its header states it. */",
			`export const RELAY_JOB_EVALUATOR_SHA256 = ${JSON.stringify(sha256(body))};`,
			"/** The commit the evaluator was generated at. */",
			`export const RELAY_JOB_SOURCE_COMMIT = ${JSON.stringify(commit)};`,
			"",
		].join("\n"),
	);
}

/** The commit and evaluator body the committed asset holds, if there is one. */
async function committedAsset(): Promise<
	Readonly<{ text: string; commit: string; bodySha: string }> | undefined
> {
	if (!existsSync(RELAY_JOB_ASSET_PATH)) return undefined;
	const text = await readFile(RELAY_JOB_ASSET_PATH, "utf8");
	const commit = /RELAY_JOB_SOURCE_COMMIT\s*=\s*"([0-9a-f]{40})"/u.exec(text);
	const bodySha = /RELAY_JOB_EVALUATOR_SHA256\s*=\s*"([0-9a-f]{64})"/u.exec(
		text,
	);
	return commit?.[1] && bodySha?.[1]
		? { text, commit: commit[1], bodySha: bodySha[1] }
		: undefined;
}

function currentCommit(): string {
	return execFileSync("git", ["rev-parse", "HEAD"], {
		cwd: REPOSITORY_ROOT,
		encoding: "utf8",
	}).trim();
}

/** Write the asset, or with `check` say whether the committed one is current. */
export async function generateRelayJobAsset(
	check: boolean,
): Promise<Readonly<{ ok: boolean; message: string }>> {
	const committed = await committedAsset();
	if (check) {
		if (!committed)
			return { ok: false, message: "the relay job asset is missing" };
		const expected = await relayJobAssetSource(committed.commit);
		return expected === committed.text
			? { ok: true, message: "the relay job asset is current" }
			: {
					ok: false,
					message:
						"the relay job asset is stale; run node --import tsx scripts/generate-relay-job.mts in packages/ci-gh-actions",
				};
	}
	const body = await relayEvaluatorBody();
	const commit =
		committed && committed.bodySha === sha256(body)
			? committed.commit
			: currentCommit();
	await writeFile(RELAY_JOB_ASSET_PATH, await relayJobAssetSource(commit));
	return { ok: true, message: `wrote ${RELAY_JOB_ASSET_PATH}` };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
	const result = await generateRelayJobAsset(process.argv.includes("--check"));
	(result.ok ? console.log : console.error)(result.message);
	if (!result.ok) process.exitCode = 1;
}
