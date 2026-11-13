/**
 * O33 (design §10.1): the deployment assets of §6.16 are safe as written.
 *
 * Parses both NATS server templates, both Compose files, every Kubernetes
 * manifest and the three service definitions, and asserts:
 * - every NATS listener requires TLS; leaf-node, MQTT and gateway listeners
 *   are absent; monitoring binds to localhost; operator mode with the full
 *   resolver; JetStream on; a control line long enough for a provisioner JWT;
 * - every Compose service drops every capability, sets no-new-privileges and
 *   keeps a read-only root; no monitoring or cluster port is published;
 * - every Kubernetes workload is non-root with a read-only root, all
 *   capabilities dropped and privilege escalation off, and the authority has
 *   a disruption budget;
 * - the systemd, launchd and Windows definitions run `hobo fleet run`;
 * - the three release images run as a non-root user.
 */
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNatsConf } from "./nats-conf.js";
import {
	at,
	entries,
	fromPlain,
	isMap,
	items,
	type Plain,
	type Tree,
	text,
	texts,
} from "./tree.js";

const root = join(import.meta.dirname, "..");
const repo = join(root, "..", "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");

// The root workspace has no YAML dependency; scripts/lint-actions.ts resolves
// the one @hobo/ci-gh-actions carries, and so does this test.
const yamlPath = createRequire(import.meta.url).resolve("yaml", {
	paths: [join(repo, "packages/ci-gh-actions")],
});
const yaml: {
	parse(source: string, options: { merge: boolean }): Plain;
	parseAllDocuments(source: string): { toJS(): Plain }[];
} = await import(yamlPath);

/** Compose files share settings through YAML merge keys (`<<: *hardening`). */
const parseYaml = (source: string): Tree =>
	fromPlain(yaml.parse(source, { merge: true }));

// ---------------------------------------------------------------- NATS

const NATS_TEMPLATES = ["nats/standalone.conf", "nats/ha.conf"] as const;
const CONTROL_LINE_FLOOR = 8 * 1024;

function expectTls(listener: Tree | undefined, where: string): void {
	expect(isMap(at(listener, "tls")), `${where} has a tls block`).toBe(true);
	expect(text(listener, "tls", "cert_file"), `${where} cert_file`).toBeTruthy();
	expect(text(listener, "tls", "key_file"), `${where} key_file`).toBeTruthy();
	expect(at(listener, "tls", "insecure"), `${where} insecure`).toBeUndefined();
}

function isLoopback(address: string): boolean {
	const host = address.slice(0, address.lastIndexOf(":"));
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

describe("NATS server templates", () => {
	for (const path of NATS_TEMPLATES) {
		describe(path, () => {
			const conf = parseNatsConf(read(path));

			it("runs in operator mode with the full resolver and JetStream", () => {
				expect(texts(conf, "include")).toContain("operator.conf");
				expect(
					at(conf, "operator"),
					"operator.conf holds the operator JWT",
				).toBeUndefined();
				expect(text(conf, "resolver", "type")).toBe("full");
				expect(text(conf, "resolver", "allow_delete")).toBe("false");
				expect(isMap(at(conf, "jetstream"))).toBe(true);
				for (const key of ["no_auth_user", "authorization", "accounts"])
					expect(at(conf, key), key).toBeUndefined();
			});

			it("requires TLS on the client listener", () => {
				expectTls(conf, "client");
				expect(text(conf, "port")).toBe("4222");
			});

			it("requires TLS on the WebSocket listener", () => {
				const ws = at(conf, "websocket");
				expect(isMap(ws)).toBe(true);
				expectTls(ws, "websocket");
				expect(text(ws, "no_tls")).not.toBe("true");
				expect(at(ws, "no_auth_user")).toBeUndefined();
			});

			it("has no leaf-node, MQTT or gateway listener", () => {
				for (const key of [
					"leafnodes",
					"leaf",
					"leafnode",
					"mqtt",
					"gateway",
					"gateways",
				])
					expect(at(conf, key), key).toBeUndefined();
			});

			it("binds monitoring to localhost only", () => {
				for (const key of ["monitor_port", "http_port", "https_port"])
					expect(at(conf, key), key).toBeUndefined();
				const monitor = text(conf, "http") ?? text(conf, "https") ?? "";
				expect(isLoopback(monitor), monitor).toBe(true);
			});

			it("accepts a control line long enough for the provisioner JWT", () => {
				expect(Number(text(conf, "max_control_line"))).toBeGreaterThanOrEqual(
					CONTROL_LINE_FLOOR,
				);
			});
		});
	}

	it("standalone has no cluster listener", () => {
		expect(
			at(parseNatsConf(read("nats/standalone.conf")), "cluster"),
		).toBeUndefined();
	});

	it("high availability has mutual-TLS cluster routes on a private interface", () => {
		const ha = parseNatsConf(read("nats/ha.conf"));
		const cluster = at(ha, "cluster");
		expectTls(cluster, "cluster");
		expect(text(cluster, "tls", "verify")).toBe("true");
		// The route listener binds the private address the deployment names, never every interface.
		expect(text(cluster, "host")).toBe("$HOBO_FLEET_NATS_CLUSTER_HOST");
		expect(items(cluster, "routes").length).toBeGreaterThanOrEqual(3);
		expect(text(ha, "server_name")).toBeTruthy();
	});
});

// ---------------------------------------------------------------- Compose

const COMPOSE_FILES = ["compose.standalone.yml", "compose.ha.yml"] as const;
const HOBO_IMAGES = [
	"hobo-fleet-authority",
	"hobo-fleet-witness",
	"hobo-fleet-relay",
	"hobo-cli",
];
const imageOf = (service: Tree) => text(service, "image") ?? "";

/** The container port of each published port. */
function publishedTargets(service: Tree): number[] {
	return items(service, "ports").map((port) => {
		if (port.kind === "scalar")
			return Number(port.text.split("/")[0]?.split(":").at(-1));
		return Number(text(port, "target"));
	});
}

describe("Compose files", () => {
	for (const path of COMPOSE_FILES) {
		describe(path, () => {
			const services = entries(parseYaml(read(path)), "services");

			it("defines NATS, the authority, the witness, a relay and the provisioning job", () => {
				const images = services.map(([, service]) => imageOf(service));
				for (const image of ["nats:", ...HOBO_IMAGES])
					expect(
						images.some((ref) => ref.includes(image)),
						image,
					).toBe(true);
			});

			it("hardens every service", () => {
				expect(services.length).toBeGreaterThan(0);
				for (const [name, service] of services) {
					expect(text(service, "read_only"), `${name} read_only`).toBe("true");
					expect(texts(service, "cap_drop"), `${name} cap_drop`).toContain(
						"ALL",
					);
					expect(texts(service, "cap_add"), `${name} cap_add`).toEqual([]);
					expect(
						texts(service, "security_opt"),
						`${name} security_opt`,
					).toContain("no-new-privileges:true");
					expect(text(service, "privileged"), `${name} privileged`).not.toBe(
						"true",
					);
					expect(
						text(service, "network_mode"),
						`${name} network_mode`,
					).not.toBe("host");
					expect(text(service, "pid"), `${name} pid`).not.toBe("host");
				}
			});

			it("runs every HoBo image as a non-root user", () => {
				for (const [name, service] of services) {
					if (!HOBO_IMAGES.some((image) => imageOf(service).includes(image)))
						continue;
					const user = text(service, "user") ?? "";
					expect(user, `${name} user`).toMatch(/^\d+:\d+$/u);
					expect(user.startsWith("0:"), `${name} is not root`).toBe(false);
				}
			});

			it("mounts the NATS template and publishes neither monitoring, cluster, leaf-node nor MQTT ports", () => {
				const nats = services.filter(([, service]) =>
					imageOf(service).startsWith("nats:"),
				);
				expect(nats.length).toBe(path === "compose.ha.yml" ? 3 : 1);
				const template =
					path === "compose.ha.yml"
						? "./nats/ha.conf"
						: "./nats/standalone.conf";
				for (const [name, service] of nats) {
					expect(
						texts(service, "volumes").some((volume) =>
							volume.startsWith(`${template}:`),
						),
						`${name} mounts ${template}`,
					).toBe(true);
					const targets = publishedTargets(service);
					for (const port of [8222, 6222, 7422, 1883])
						expect(targets, name).not.toContain(port);
				}
			});

			it("publishes the authority on loopback only (TLS ends in front of it)", () => {
				for (const [name, service] of services) {
					if (!imageOf(service).includes("hobo-fleet-authority")) continue;
					for (const port of items(service, "ports")) {
						const published =
							port.kind === "scalar"
								? port.text
								: (text(port, "host_ip") ?? "");
						expect(
							published.startsWith("127.0.0.1:") || published === "127.0.0.1",
							`${name} ${published}`,
						).toBe(true);
					}
				}
			});

			it("runs the provisioning job only on request", () => {
				const provision = services.filter(([, service]) =>
					texts(service, "command").join(" ").includes("fleet ops provision"),
				);
				expect(provision.length).toBe(1);
				const job = provision[0]?.[1];
				expect(texts(job, "profiles")).toContain("provision");
				expect(text(job, "restart")).toBe("no");
			});
		});
	}
});

// ---------------------------------------------------------------- Kubernetes

const WORKLOAD_KINDS = new Set([
	"Deployment",
	"StatefulSet",
	"DaemonSet",
	"Job",
	"CronJob",
	"Pod",
	"ReplicaSet",
]);

function kubernetesObjects(): Tree[] {
	const dir = join(root, "kubernetes");
	return readdirSync(dir)
		.filter((name) => name.endsWith(".yaml") && name !== "kustomization.yaml")
		.flatMap((name) =>
			yaml
				.parseAllDocuments(readFileSync(join(dir, name), "utf8"))
				.map((doc) => fromPlain(doc.toJS())),
		)
		.filter(isMap);
}

function podSpec(object: Tree): Tree | undefined {
	switch (text(object, "kind")) {
		case "Pod":
			return at(object, "spec");
		case "CronJob":
			return at(object, "spec", "jobTemplate", "spec", "template", "spec");
		default:
			return at(object, "spec", "template", "spec");
	}
}

const nameOf = (object: Tree) =>
	`${text(object, "kind")}/${text(object, "metadata", "name")}`;

describe("Kubernetes manifests", () => {
	const objects = kubernetesObjects();
	const workloads = objects.filter((object) =>
		WORKLOAD_KINDS.has(text(object, "kind") ?? ""),
	);

	it("define the NATS servers, the authority, the witness, the relay and the provisioning job", () => {
		const names = workloads.map(nameOf);
		for (const expected of [
			"StatefulSet/hobo-fleet-nats",
			"Deployment/hobo-fleet-authority",
			"Deployment/hobo-fleet-witness",
			"Deployment/hobo-fleet-relay",
			"Job/hobo-fleet-provision",
		])
			expect(names).toContain(expected);
	});

	it("run every workload non-root, read-only, with every capability dropped and no privilege escalation", () => {
		expect(workloads.length).toBeGreaterThan(0);
		for (const workload of workloads) {
			const name = nameOf(workload);
			const pod = podSpec(workload);
			expect(isMap(pod), `${name} pod spec`).toBe(true);
			expect(
				text(pod, "securityContext", "runAsNonRoot"),
				`${name} runAsNonRoot`,
			).toBe("true");
			expect(
				Number(text(pod, "securityContext", "runAsUser")),
				`${name} runAsUser`,
			).toBeGreaterThan(0);
			expect(
				text(pod, "securityContext", "seccompProfile", "type"),
				`${name} seccomp`,
			).toBe("RuntimeDefault");
			for (const key of ["hostNetwork", "hostPID", "hostIPC"])
				expect(text(pod, key), `${name} ${key}`).not.toBe("true");
			const containers = [
				...items(pod, "initContainers"),
				...items(pod, "containers"),
			];
			expect(containers.length, `${name} containers`).toBeGreaterThan(0);
			for (const container of containers) {
				const where = `${name} ${text(container, "name")}`;
				const context = at(container, "securityContext");
				expect(
					text(context, "readOnlyRootFilesystem"),
					`${where} readOnlyRootFilesystem`,
				).toBe("true");
				expect(
					text(context, "allowPrivilegeEscalation"),
					`${where} allowPrivilegeEscalation`,
				).toBe("false");
				expect(text(context, "privileged"), `${where} privileged`).not.toBe(
					"true",
				);
				expect(text(context, "runAsNonRoot"), `${where} runAsNonRoot`).not.toBe(
					"false",
				);
				const user = text(context, "runAsUser");
				if (user !== undefined)
					expect(Number(user), `${where} runAsUser`).toBeGreaterThan(0);
				expect(
					texts(context, "capabilities", "drop"),
					`${where} drop`,
				).toContain("ALL");
				expect(texts(context, "capabilities", "add"), `${where} add`).toEqual(
					[],
				);
			}
		}
	});

	it("give the authority at least two replicas and a disruption budget that keeps one up", () => {
		const authority = workloads.find(
			(object) => nameOf(object) === "Deployment/hobo-fleet-authority",
		);
		const replicas = Number(text(authority, "spec", "replicas"));
		expect(replicas).toBeGreaterThanOrEqual(2);
		const labels = new Map(
			entries(authority, "spec", "template", "metadata", "labels").map(
				([key, value]) => [key, text(value)],
			),
		);
		const budget = objects
			.filter((object) => text(object, "kind") === "PodDisruptionBudget")
			.find((object) => {
				const selector = entries(object, "spec", "selector", "matchLabels");
				return (
					selector.length > 0 &&
					selector.every(([key, value]) => labels.get(key) === text(value))
				);
			});
		expect(budget, "a PodDisruptionBudget selects the authority").toBeDefined();
		const minAvailable = text(budget, "spec", "minAvailable");
		const maxUnavailable = text(budget, "spec", "maxUnavailable");
		const keepsOne =
			minAvailable !== undefined
				? Number(minAvailable) >= 1
				: maxUnavailable !== undefined && Number(maxUnavailable) < replicas;
		expect(keepsOne).toBe(true);
	});

	it("serve the NATS servers from the high-availability template", () => {
		const kustomization = parseYaml(read("kubernetes/kustomization.yaml"));
		const files = items(kustomization, "configMapGenerator").flatMap(
			(generator) => texts(generator, "files"),
		);
		expect(files).toContain("nats.conf=../nats/ha.conf");
	});
});

// ---------------------------------------------------------------- service configuration

/** The protobuf JSON names of a message's fields in the authority's data model. */
function jsonFieldNames(message: string): Set<string> {
	const proto = readFileSync(
		join(repo, "packages/fleet-authority/data-models/fleet_authority.proto"),
		"utf8",
	);
	const body =
		new RegExp(`message ${message} \\{([\\s\\S]*?)\\n\\}`, "u").exec(
			proto,
		)?.[1] ?? "";
	return new Set(
		[...body.matchAll(/^\s*(?:repeated\s+)?[\w.]+\s+(\w+)\s*=\s*\d+;/gmu)].map(
			(match) =>
				(match[1] ?? "").replace(/_(\w)/gu, (_, letter: string) =>
					letter.toUpperCase(),
				),
		),
	);
}

describe("service configuration", () => {
	const configFields = jsonFieldNames("FleetAuthorityConfig");
	const storeFields = jsonFieldNames("SecretStoreConfig");
	const files = readdirSync(join(root, "config")).filter((name) =>
		name.endsWith(".json"),
	);

	it("names a configuration for the authority, the witness and the provisioner in both profiles", () => {
		for (const service of ["authority", "witness", "provisioner"])
			for (const profile of ["standalone", "ha"])
				expect(files).toContain(`${service}.${profile}.json`);
	});

	for (const file of files) {
		it(`${file} is a FleetAuthorityConfig on OpenBao with TLS NATS URLs`, () => {
			const config = fromPlain(JSON.parse(read(`config/${file}`)));
			expect(configFields.size).toBeGreaterThan(10);
			for (const [key] of entries(config))
				expect(configFields.has(key), key).toBe(true);
			for (const [key] of entries(config, "secretStore"))
				expect(storeFields.has(key), `secretStore.${key}`).toBe(true);
			expect(text(config, "secretStore", "kind")).toBe("openbao");
			expect(text(config, "secretStore", "tokenFile")).toBe(
				"/run/secrets/openbao-token",
			);
			expect(text(config, "issuer")).toMatch(/^https:\/\/[^/]+$/u);
			expect(text(config, "profile")).toBe(
				file.includes(".ha.") ? "high-availability" : "standalone",
			);
			const urls = texts(config, "natsUrls");
			expect(urls.length).toBe(file.includes(".ha.") ? 3 : 1);
			for (const url of urls) expect(url).toMatch(/^tls:\/\//u);
		});
	}

	it("gives the authority, the witness and the provisioner each their own OpenBao role", () => {
		const roles = new Map(
			files.map((file) => [
				file,
				text(
					fromPlain(JSON.parse(read(`config/${file}`))),
					"secretStore",
					"role",
				),
			]),
		);
		for (const [file, role] of roles)
			expect(role, file).toBe(`hobo-fleet-${file.split(".")[0]}`);
	});
});

// ---------------------------------------------------------------- service definitions

const ARGUMENT = /"([^"]*)"|(\S+)/gu;
const splitArguments = (line: string) =>
	[...line.matchAll(ARGUMENT)].map((match) => match[1] ?? match[2] ?? "");

function systemdExecStart(unit: string): string[] {
	const line = unit.split("\n").find((entry) => entry.startsWith("ExecStart="));
	return line === undefined
		? []
		: splitArguments(line.slice("ExecStart=".length));
}

function plistProgramArguments(plist: string): string[] {
	const block =
		/<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/u.exec(
			plist,
		)?.[1] ?? "";
	return [...block.matchAll(/<string>([^<]*)<\/string>/gu)].map(
		(match) => match[1] ?? "",
	);
}

function windowsCommandLine(task: string): string[] {
	const command = /<Command>([^<]*)<\/Command>/u.exec(task)?.[1] ?? "";
	const args = /<Arguments>([^<]*)<\/Arguments>/u.exec(task)?.[1] ?? "";
	return [command, ...splitArguments(args)];
}

/** `hobo fleet run`, whether `hobo` is the executable or the script node runs. */
function runsHoboFleetRun(argv: readonly string[]): boolean {
	const hobo = argv.findIndex((arg) =>
		/(^|[\\/])hobo(\.exe|\.js|\.cmd)?$/u.test(arg),
	);
	return hobo >= 0 && argv[hobo + 1] === "fleet" && argv[hobo + 2] === "run";
}

describe("service definitions", () => {
	it("the systemd unit runs `hobo fleet run`, restarts on failure and cannot gain privileges", () => {
		const unit = read("service/hobo-fleet.service");
		const argv = systemdExecStart(unit);
		expect(runsHoboFleetRun(argv), argv.join(" ")).toBe(true);
		expect(unit).toMatch(/^Restart=on-failure$/mu);
		expect(unit).toMatch(/^NoNewPrivileges=yes$/mu);
	});

	it("the launchd agent runs `hobo fleet run` and keeps it alive", () => {
		const plist = read("service/dev.hobo.fleet.plist");
		const argv = plistProgramArguments(plist);
		expect(runsHoboFleetRun(argv), argv.join(" ")).toBe(true);
		expect(plist).toContain("<key>KeepAlive</key>");
		expect(plist).toContain("<string>dev.hobo.fleet</string>");
	});

	it("the Windows definition runs `hobo fleet run` with least privilege", () => {
		const task = read("service/hobo-fleet.xml");
		const argv = windowsCommandLine(task);
		expect(runsHoboFleetRun(argv), argv.join(" ")).toBe(true);
		expect(task).toContain("<RunLevel>LeastPrivilege</RunLevel>");
	});
});

// ---------------------------------------------------------------- release images

const dockerfile = (image: string) =>
	readFileSync(
		join(repo, "deploy/release-images", image, "Dockerfile"),
		"utf8",
	);

describe("release images", () => {
	for (const image of [
		"hobo-fleet-authority",
		"hobo-fleet-witness",
		"hobo-fleet-relay",
	]) {
		it(`${image} runs as a non-root user with OCI labels`, () => {
			const source = dockerfile(image);
			const users = [...source.matchAll(/^USER\s+(\S+)/gmu)].map(
				(match) => match[1],
			);
			expect(users.at(-1)).toBe("1000:1000");
			expect(source).toContain("org.opencontainers.image.version");
			expect(source).toContain("org.opencontainers.image.revision");
			expect(source).toMatch(/^ENTRYPOINT \[/mu);
		});
	}

	it("the relay image verifies the pinned iroh-relay download", () => {
		const source = dockerfile("hobo-fleet-relay");
		expect(source).toMatch(/sha256sum -c/u);
		expect(source).toContain("IROH_RELAY_VERSION=1.4.1");
	});
});
