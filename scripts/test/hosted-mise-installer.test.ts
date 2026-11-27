import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const action = ".github/actions/ci-runner-preflight";
const version = readFileSync(
	join(repo, "packages/ci-gh-actions/deploy/ci-runner/mise-version.txt"),
	"utf8",
).trim();

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "hobo-hosted-mise-"));
	const bin = join(root, "bin");
	const actionDir = join(root, action);
	const versionPath = join(
		root,
		"packages/ci-gh-actions/deploy/ci-runner/mise-version.txt",
	);
	for (const directory of [
		bin,
		actionDir,
		dirname(versionPath),
		join(root, "scripts/lib"),
	])
		mkdirSync(directory, { recursive: true });
	copyFileSync(
		join(repo, action, "hosted-toolchain.sh"),
		join(actionDir, "hosted-toolchain.sh"),
	);
	copyFileSync(
		join(repo, "scripts/lib/mise-path.sh"),
		join(root, "scripts/lib/mise-path.sh"),
	);
	writeFileSync(join(root, "mise.toml"), "[tools]\n");
	writeFileSync(versionPath, `${version}\n`);
	const installer = join(root, "installer.sh");
	const installerBody = `#!/bin/sh
cat > "$MISE_INSTALL_PATH" <<'MISE'
#!/bin/sh
case "$1" in
  --version) echo '${version} linux-x64' ;;
  bin-paths) dirname "$0" ;;
  trust|install) exit 0 ;;
  *) exit 1 ;;
esac
MISE
chmod +x "$MISE_INSTALL_PATH"
`;
	writeFileSync(installer, installerBody);
	const digest = createHash("sha256").update(installerBody).digest("hex");
	writeFileSync(
		join(actionDir, "mise-installer.sha256"),
		`${digest}  mise-v${version}-install.sh\n`,
	);
	const curl = join(bin, "curl");
	writeFileSync(
		curl,
		`#!/bin/sh
out=''
url=''
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    --retry) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf '%s\\n' "$url" >> "$HOBO_MISE_TEST_CURL_LOG"
case "$url" in
  https://mise.jdx.dev/v*/install.sh) cp "$HOBO_MISE_TEST_INSTALLER" "$out" ;;
  file://*) cat "\${url#file://}" ;;
  *) exit 22 ;;
esac
`,
	);
	chmodSync(curl, 0o755);
	const target = join(root, "tools", "mise");
	mkdirSync(dirname(target), { recursive: true });
	const output = join(root, "github-path");
	writeFileSync(output, "");
	const curlLog = join(root, "curl.log");
	const run = () =>
		spawnSync("bash", [join(actionDir, "hosted-toolchain.sh")], {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}:/usr/bin:/bin`,
				RUNNER_ENVIRONMENT: "github-hosted",
				GITHUB_PATH: output,
				MISE_INSTALL_PATH: target,
				MISE_INSTALL_ATTEMPTS: "1",
				MISE_INSTALL_RETRY_DELAY: "0",
				HOBO_MISE_TEST_CURL_LOG: curlLog,
				HOBO_MISE_TEST_INSTALLER: installer,
			},
		});
	return { root, installer, versionPath, target, curlLog, run };
}

describe("hosted mise bootstrap", () => {
	it("uses a verified versioned installer when the mutable installer cannot fetch release checksums", () => {
		const f = fixture();
		try {
			const result = f.run();
			assert.equal(result.status, 0, result.stderr);
			assert.ok(existsSync(f.target));
			assert.ok(
				readFileSync(f.curlLog, "utf8").includes(
					`https://mise.jdx.dev/v${version}/install.sh`,
				),
			);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("refuses to execute a versioned installer whose pinned digest does not match", () => {
		const f = fixture();
		try {
			writeFileSync(f.installer, "#!/bin/sh\nexit 0\n");
			const result = f.run();
			assert.notEqual(result.status, 0);
			assert.equal(existsSync(f.target), false);
			assert.match(result.stderr, /checksum|digest/u);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("refuses an unpinned installer version", () => {
		const f = fixture();
		try {
			writeFileSync(f.versionPath, "9999.0.0\n");
			const result = f.run();
			assert.notEqual(result.status, 0);
			assert.equal(existsSync(f.target), false);
			assert.match(result.stderr, /checksum|digest/u);
		} finally {
			rmSync(f.root, { recursive: true, force: true });
		}
	});

	it("keeps the repository installer digest tied to the pinned version", () => {
		const pin = readFileSync(
			join(repo, action, "mise-installer.sha256"),
			"utf8",
		).trim();
		assert.match(
			pin,
			new RegExp(
				`^[0-9a-f]{64}  mise-v${version.replaceAll(".", "\\.")}-install\\.sh$`,
				"u",
			),
		);
	});
});
