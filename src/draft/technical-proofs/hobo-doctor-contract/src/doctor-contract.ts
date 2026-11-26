import { access, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { isJsonString, isJsonObject } from "./json.js";


export const HOBO_DOCTOR_CONTRACT_VERSION = "hobo.doctor/v1";

const CHECK_ORDER = [
  "toolchain.node",
  "toolchain.jco",
  "toolchain.containerRuntime",
  "identity.svid",
  "connectivity.readApi",
  "connectivity.streamer",
  "local.hobo",
  "portability.staticScan",
];
const SKIPPED_DIRS = new Set([".git", ".hobo", "node_modules", "dist", "coverage"]);
const SCANNED_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".mts", ".ts", ".tsx"]);

export function createHealthyDoctorFixture(options = {}) {
  const credential = options.credential ?? {
    svidRef: "keychain://hobo.dev-svid",
    expiresAt: "2999-01-01T00:00:00.000Z",
  };

  return {
    toolchain: {
      node: { ok: true, version: "v24.0.0" },
      jco: { ok: true, version: "1.0.0" },
      containerRuntime: { ok: true, version: "podman 5" },
    },
    credentialStore: {
      async read() {
        return credential;
      },
    },
    connectivity: {
      readApi: async () => ({ ok: true }),
      streamer: async () => ({ ok: true }),
    },
  };
}

export function createHoboDoctorCli(options = {}) {
  return {
    async run(argv = [], runOptions = {}) {
      try {
        const flags = parseDoctorArgv(argv);
        const report = await runDoctor({
          ...options,
          cwd: runOptions.cwd ?? process.cwd(),
          env: runOptions.env ?? process.env,
          offline: flags.offline,
        });
        return renderDoctorResult(report, flags);
      } catch (error) {
        return {
          exitCode: 1,
          stdout: "",
          stderr: `${redact(error?.message || "doctor failed")}\n`,
        };
      }
    },
  };
}

export function createDoctorCommand(options = {}) {
  return {
    async run({ context, flags }) {
      const report = await runDoctor({
        ...options,
        cwd: context.projectDir ?? context.cwd,
        env: context.env ?? process.env,
        offline: flags.offline === true,
      });

      return {
        ok: report.ok,
        status: report.status,
        code: report.ok ? "HOBO_DOCTOR_OK" : "HOBO_DOCTOR_FAILED",
        message: report.summary,
        data: report,
      };
    },
  };
}

export async function runDoctor(options = {}) {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const checks = [];
  const findings = [];

  checks.push(...await runToolchainChecks(options.toolchain));
  checks.push(await runSvidCheck(options.credentialStore));
  checks.push(...await runConnectivityChecks(options, options.offline === true));
  checks.push(await runLocalStoreCheck(cwd));

  const staticFindings = await scanProjectPortability(cwd);
  findings.push(...staticFindings);
  checks.push({
    id: "portability.staticScan",
    title: "Portable authoring surface",
    status: staticFindings.length === 0 ? "pass" : "warn",
    message: staticFindings.length === 0
      ? "No non-portable authoring hazards found."
      : `${staticFindings.length} portability warning${staticFindings.length === 1 ? "" : "s"} found.`,
    remediation: staticFindings.length === 0
      ? null
      : { command: "Replace .raw() usage or bind live views to reactive sinks." },
  });

  for (const extraCheck of options.extraChecks ?? []) {
    checks.push(await runExtraCheck(extraCheck));
  }

  const orderedChecks = orderChecks(checks);
  const orderedFindings = findings.sort((left, right) =>
    `${left.file}:${left.line}:${left.code}`.localeCompare(`${right.file}:${right.line}:${right.code}`)
  );
  const hasFailures = orderedChecks.some((check) => check.status === "fail");
  const hasWarnings = orderedChecks.some((check) => check.status === "warn") || orderedFindings.length > 0;
  const status = hasFailures ? "failed" : hasWarnings ? "warning" : "healthy";

  return sanitizeReport({
    schema: HOBO_DOCTOR_CONTRACT_VERSION,
    ok: !hasFailures,
    status,
    summary: summaryFor(status),
    checks: orderedChecks,
    findings: orderedFindings,
  });
}

function parseDoctorArgv(argv) {
  const flags = {
    json: false,
    offline: false,
  };

  for (const token of argv) {
    switch (token) {
      case "--json":
        flags.json = true;
        break;
      case "--offline":
        flags.offline = true;
        break;
      default:
        throw new Error(`Unknown doctor option "${token}".`);
    }
  }

  return flags;
}

async function runToolchainChecks(toolchain) {
  return [
    await runProbeCheck("toolchain.node", "Node.js runtime", toolchain.node),
    await runProbeCheck("toolchain.jco", "WebAssembly component toolchain", toolchain.jco),
    await runProbeCheck("toolchain.containerRuntime", "Container runtime", toolchain.containerRuntime),
  ];
}

async function runSvidCheck(credentialStore) {
  try {
    const credential = await credentialStore?.read?.("hobo.dev-svid");
    if (!credential) {
      return {
        id: "identity.svid",
        title: "Developer SVID",
        status: "fail",
        message: "not logged in -> hobo login",
        remediation: { command: "hobo login" },
      };
    }

    if (credential.expiresAt && Date.parse(credential.expiresAt) <= Date.now()) {
      return {
        id: "identity.svid",
        title: "Developer SVID",
        status: "fail",
        message: "developer SVID expired -> hobo login",
        remediation: { command: "hobo login" },
      };
    }

    return {
      id: "identity.svid",
      title: "Developer SVID",
      status: "pass",
      message: credential.expiresAt
        ? `Developer SVID valid until ${credential.expiresAt}.`
        : "Developer SVID available.",
      subject: credential.subject ?? credential.svidRef ?? null,
    };
  } catch (error) {
    return erroredCheck("identity.svid", "Developer SVID", error);
  }
}

async function runConnectivityChecks(options, offline) {
  if (offline) {
    return [
      skippedConnectivityCheck("connectivity.readApi", "Camp read API"),
      skippedConnectivityCheck("connectivity.streamer", "Camp Streamer"),
    ];
  }

  const connectivity = options.connectivity ?? {};
  return [
    await runProbeCheck("connectivity.readApi", "Camp read API", connectivity.readApi),
    await runProbeCheck("connectivity.streamer", "Camp Streamer", connectivity.streamer),
  ];
}

async function runLocalStoreCheck(cwd) {
  const hoboDir = path.join(cwd, ".hobo");
  const manifestPath = path.join(hoboDir, "manifest.json");

  if (!await exists(hoboDir)) {
    return {
      id: "local.hobo",
      title: "Local .hobo store",
      status: "warn",
      message: ".hobo store is missing; local state will be initialized on first use.",
      remediation: { command: "hobo init" },
    };
  }

  if (!await exists(manifestPath)) {
    return {
      id: "local.hobo",
      title: "Local .hobo store",
      status: "warn",
      message: ".hobo manifest is missing.",
      remediation: { command: "hobo doctor --repair" },
    };
  }

  try {
    JSON.parse(await readFile(manifestPath, "utf8"));
    return {
      id: "local.hobo",
      title: "Local .hobo store",
      status: "pass",
      message: ".hobo manifest is readable.",
    };
  } catch (error) {
    return {
      id: "local.hobo",
      title: "Local .hobo store",
      status: "fail",
      message: `check errored: ${error.message}`,
      remediation: { command: "Recreate .hobo metadata from source-controlled project files." },
    };
  }
}

async function runProbeCheck(id, title, probe) {
  try {
    return normalizeCheck(id, title, await resolveProbe(probe, { ok: true }));
  } catch (error) {
    return erroredCheck(id, title, error);
  }
}

async function runExtraCheck(extraCheck) {
  try {
    return normalizeCheck(extraCheck.id, extraCheck.title ?? extraCheck.id, await extraCheck.run());
  } catch (error) {
    return erroredCheck(extraCheck.id, extraCheck.title ?? extraCheck.id, error);
  }
}

async function resolveProbe(probe, fallback) {
  if (probe instanceof Function) {
    return await probe();
  }

  return probe ?? fallback;
}

function normalizeCheck(id, title, result) {
  const severity = result.severity ?? (result.ok === false ? "error" : "pass");
  const status = result.status ?? statusFromResult(result.ok !== false, severity);
  const command = result.remediation?.command ?? result.remediation ?? result.fix ?? null;

  return stripNullValues({
    id,
    title,
    status,
    message: result.message ?? defaultCheckMessage(title, status, result.version),
    version: result.version ?? null,
    remediation: command ? { command } : null,
  });
}

function statusFromResult(ok, severity) {
  if (ok) {
    return "pass";
  }

  return severity === "warning" ? "warn" : "fail";
}

function defaultCheckMessage(title, status, version) {
  if (status === "pass") {
    return version ? `${title} available (${version}).` : `${title} available.`;
  }

  if (status === "warn") {
    return `${title} degraded.`;
  }

  return `${title} missing or unreachable.`;
}

function skippedConnectivityCheck(id, title) {
  return {
    id,
    title,
    status: "skip",
    message: "offline mode: skipped",
  };
}

function erroredCheck(id, title, error) {
  return {
    id,
    title,
    status: "fail",
    message: `check errored: ${redact(error?.message || "unknown failure")}`,
  };
}

async function scanProjectPortability(cwd) {
  const files = await listSourceFiles(cwd);
  const findings = [];

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const relativeFile = toPortablePath(path.relative(cwd, filePath));
    const lines = content.split(/\r?\n/);

    lines.forEach((line, index) => {
      if (line.includes(".raw(")) {
        findings.push({
          code: "portability.raw-access",
          severity: "warning",
          file: relativeFile,
          line: index + 1,
          message: ".raw() uses provider-native APIs and is non-portable across Camps.",
          remediation: {
            command: "Wrap the capability in a portable interface or mark it as a raw hatch.",
          },
        });
      }

      if (looksLikeNonReactiveLiveBinding(line)) {
        findings.push({
          code: "portability.non-reactive-live-view",
          severity: "warning",
          file: relativeFile,
          line: index + 1,
          message: "Live view is bound to a non-reactive sink; use snapshot reads or a reactive sink.",
          remediation: {
            command: "Bind live views only to native/change-feed sinks.",
          },
        });
      }
    });
  }

  return findings;
}

async function listSourceFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) {
        files.push(...await listSourceFiles(fullPath));
      }
      continue;
    }

    if (entry.isFile() && SCANNED_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }

  return files.sort();
}

function looksLikeNonReactiveLiveBinding(line) {
  return /\b(useQuery|subscribe|liveView)\s*\(/.test(line)
    && /non[-_ ]reactive|reactive\s*:\s*false|no-change-feed/.test(line);
}

function renderDoctorResult(report, flags) {
  if (flags.json) {
    return {
      exitCode: report.ok ? 0 : 1,
      stdout: `${JSON.stringify(report)}\n`,
      stderr: "",
    };
  }

  return {
    exitCode: report.ok ? 0 : 1,
    stdout: `${renderHumanReport(report)}\n`,
    stderr: "",
  };
}

function renderHumanReport(report) {
  if (report.status === "healthy") {
    return "All doctor checks passed";
  }

  const rows = report.checks
    .filter((check) => check.status !== "pass")
    .map((check) => `${check.status.toUpperCase()} ${check.id}: ${check.message}`);
  const findings = report.findings.map((finding) =>
    `WARN ${finding.file}:${finding.line} ${finding.code}: ${finding.message}`
  );

  return [report.summary, ...rows, ...findings].join("\n");
}

function orderChecks(checks) {
  return checks
    .map((check) => sanitizeCheck(check))
    .sort((left, right) => {
      const leftIndex = CHECK_ORDER.indexOf(left.id);
      const rightIndex = CHECK_ORDER.indexOf(right.id);
      const leftSort = leftIndex === -1 ? CHECK_ORDER.length : leftIndex;
      const rightSort = rightIndex === -1 ? CHECK_ORDER.length : rightIndex;
      return leftSort - rightSort || left.id.localeCompare(right.id);
    });
}

function sanitizeCheck(check) {
  return stripNullValues({
    ...check,
    message: redact(check.message),
    remediation: check.remediation ? stripNullValues({
      ...check.remediation,
      command: redact(check.remediation.command),
    }) : null,
  });
}

function sanitizeReport(report) {
  return sanitizeValue(stripNullValues(report));
}

function stripNullValues(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)
  );
}

function sanitizeValue(value) {
  if (isJsonString(value)) {
    return redact(value);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => sanitizeValue(entry));
  }

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, entry]) => entry !== null && entry !== undefined)
        .map(([key, entry]) => [key, sanitizeValue(entry)])
    );
  }

  return value;
}

function summaryFor(status) {
  switch (status) {
    case "failed":
      return "missing required doctor checks";
    case "warning":
      return "doctor checks completed with warnings";
    default:
      return "all doctor checks passed";
  }
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function toPortablePath(filePath) {
  return filePath.split(path.sep).join("/");
}

function redact(value) {
  if (!isJsonString(value)) {
    return value;
  }

  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [REDACTED]")
    .replace(/\b(token|secret|password)=[^\s"',}]+/gi, "$1=[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+){1,2}\b/g, "[REDACTED]");
}
