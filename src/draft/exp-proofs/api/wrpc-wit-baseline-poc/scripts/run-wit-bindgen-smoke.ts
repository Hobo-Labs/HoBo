import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("..", import.meta.url);
const toolsRoot = new URL(".tools/", root);
const lock = JSON.parse(await readFile(new URL("toolchain-lock.json", root), "utf8"));
const version = lock.toolchain.witBindgenCli.version;
const outputDir = fileURLToPath(new URL(".generated/wit-bindgen-smoke", root));
const rootPath = fileURLToPath(root);
const toolsRootPath = fileURLToPath(toolsRoot);

const releaseTargets = {
  darwin: {
    arm64: { archiveType: "tar.gz", target: "aarch64-macos" },
    x64: { archiveType: "tar.gz", target: "x86_64-macos" },
  },
  linux: {
    arm64: { archiveType: "tar.gz", target: "aarch64-linux" },
    riscv64: { archiveType: "tar.gz", target: "riscv64gc-linux" },
    x64: { archiveType: "tar.gz", target: "x86_64-linux" },
  },
  win32: {
    arm64: { archiveType: "zip", target: "aarch64-windows" },
    x64: { archiveType: "zip", target: "x86_64-windows" },
  },
};

const release = releaseTargets[process.platform]?.[process.arch];
assert.ok(release, `no wit-bindgen release target for ${process.platform}/${process.arch}`);

const archiveName = `wit-bindgen-${version}-${release.target}.${release.archiveType}`;
const toolDirName = `wit-bindgen-${version}-${release.target}`;
const binName = process.platform === "win32" ? "wit-bindgen.exe" : "wit-bindgen";
const archivePath = fileURLToPath(new URL(archiveName, toolsRoot));
const toolPath = fileURLToPath(new URL(`${toolDirName}/${binName}`, toolsRoot));
const downloadUrl =
  `https://github.com/bytecodealliance/wit-bindgen/releases/download/v${version}/${archiveName}`;

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: rootPath,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

async function downloadReleaseArchive() {
  await mkdir(toolsRoot, { recursive: true });
  let response;
  try {
    response = await fetch(downloadUrl);
  } catch (cause) {
    // A bare `fetch failed` here surfaces as an unhandled TypeError with an
    // undici stack and no mention of the URL, which reads like a code defect
    // rather than "this machine cannot reach the network". The TLS case is
    // worth naming: behind an intercepting proxy the chain terminates in the
    // proxy's own root, and the fix is to trust that root — never to disable
    // verification, which would hand the toolchain download to anyone on path.
    // SAFETY: `const code = (cause as { cause?: { code?: string } })?.cause?.code;` is required at this I/O or test boundary.
    const code = (cause as { cause?: { code?: string } })?.cause?.code;
    const tls =
      code === "SELF_SIGNED_CERT_IN_CHAIN" ||
      code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
      code === "UNABLE_TO_GET_ISSUER_CERT_LOCALLY";
    throw new Error(
      `could not download ${downloadUrl}` +
        (tls
          ? `: TLS chain rejected (${code}). Behind a TLS-intercepting proxy, ` +
            "point NODE_EXTRA_CA_CERTS at the proxy's CA bundle and re-run."
          : ": network unreachable."),
      { cause },
    );
  }
  assert.equal(response.ok, true, `failed to download ${downloadUrl}: HTTP ${response.status}`);
  await writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
}

async function extractReleaseArchive() {
  await rm(new URL(toolDirName, toolsRoot), { force: true, recursive: true });
  run("tar", ["-xf", archivePath, "-C", toolsRootPath], { stdio: "inherit" });
}

if (!existsSync(toolPath)) {
  await downloadReleaseArchive();
  await extractReleaseArchive();
}

const versionOutput = run(toolPath, ["--version"]);
assert.match(versionOutput, new RegExp(`wit-bindgen-cli ${version.replaceAll(".", "\\.")}`));

await rm(outputDir, { force: true, recursive: true });
await mkdir(outputDir, { recursive: true });

run(toolPath, ["markdown", "wit", "--out-dir", outputDir], { stdio: "inherit" });

console.log(`wit-bindgen smoke ok: wit-bindgen-cli@${version}`);
