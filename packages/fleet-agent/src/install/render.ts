// The service definitions `hobo fleet service install` writes (design §6.15):
// a systemd user unit, a launchd agent and a Windows scheduled task. Pure
// text; `index.ts` decides where each goes. Each restarts the agent when it
// fails and gives it two minutes to drain on stop.

// public-contract: the launchd label, also the plist's file name.
export const LAUNCHD_LABEL = "dev.hobo.fleet";
// public-contract: the systemd unit name and the scheduled task's name.
export const SERVICE_NAME = "hobo-fleet";

/** The variables of §6.15 the agent reads; `HOBO_FLEET_NATS_SERVER_BIN` is test-only and never passed on. */
const AGENT_VARIABLES = [
	"HOBO_FLEET_AUTHORITY_URL",
	"HOBO_FLEET_TENANT",
	"HOBO_FLEET_HOME",
	"HOBO_FLEET_FLEETS",
	"HOBO_FLEET_SANDBOX",
	"HOBO_FLEET_TRANSPORTS",
	"HOBO_FLEET_KEYSTORE",
] as const;

export type ServiceEnvironment = Readonly<Partial<Record<string, string>>>;

/** The agent's variables set in `environment`, by name; nothing else. */
export function serviceEnvironment(
	environment: ServiceEnvironment,
): ServiceEnvironment {
	const picked: [string, string][] = [];
	for (const name of AGENT_VARIABLES) {
		const value = environment[name];
		if (value !== undefined && value !== "") picked.push([name, value]);
	}
	return Object.freeze(Object.fromEntries(picked));
}

const sortedEntries = (environment: ServiceEnvironment) =>
	Object.entries(environment)
		.filter((entry): entry is [string, string] => entry[1] !== undefined)
		.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

/** One systemd word: double-quoted, with `\`, `"`, `%` and `$` escaped. */
function systemdWord(value: string): string {
	const escaped = value
		.replaceAll("\\", "\\\\")
		.replaceAll('"', '\\"')
		.replaceAll("%", "%%")
		.replaceAll("$", "$$$$");
	return `"${escaped}"`;
}

export function renderSystemdUnit(
	argv: readonly string[],
	environment: ServiceEnvironment,
): string {
	const lines = [
		"# Written by `hobo fleet service install`; reinstall to change it.",
		"[Unit]",
		"Description=HoBo Fleet agent",
		"After=network-online.target",
		"Wants=network-online.target",
		"",
		"[Service]",
		"Type=simple",
		`ExecStart=${argv.map(systemdWord).join(" ")}`,
		...sortedEntries(environment).map(
			([name, value]) => `Environment=${systemdWord(`${name}=${value}`)}`,
		),
		"Restart=on-failure",
		"RestartSec=10",
		"KillSignal=SIGTERM",
		"TimeoutStopSec=120",
		"NoNewPrivileges=yes",
		"",
		"[Install]",
		"WantedBy=default.target",
	];
	return `${lines.join("\n")}\n`;
}

/** Escapes element text (never used inside an attribute). */
function xml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");
}

export function renderLaunchdPlist(
	argv: readonly string[],
	environment: ServiceEnvironment,
): string {
	const variables = sortedEntries(environment);
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		'<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
		"<!-- Written by `hobo fleet service install`; reinstall to change it. -->",
		'<plist version="1.0">',
		"<dict>",
		"\t<key>Label</key>",
		`\t<string>${LAUNCHD_LABEL}</string>`,
		"\t<key>ProgramArguments</key>",
		"\t<array>",
		...argv.map((arg) => `\t\t<string>${xml(arg)}</string>`),
		"\t</array>",
		...(variables.length === 0
			? []
			: [
					"\t<key>EnvironmentVariables</key>",
					"\t<dict>",
					...variables.flatMap(([name, value]) => [
						`\t\t<key>${xml(name)}</key>`,
						`\t\t<string>${xml(value)}</string>`,
					]),
					"\t</dict>",
				]),
		"\t<key>RunAtLoad</key>",
		"\t<true/>",
		"\t<key>KeepAlive</key>",
		"\t<dict>",
		"\t\t<key>SuccessfulExit</key>",
		"\t\t<false/>",
		"\t</dict>",
		"\t<key>ThrottleInterval</key>",
		"\t<integer>10</integer>",
		"\t<key>ExitTimeOut</key>",
		"\t<integer>120</integer>",
		"\t<key>ProcessType</key>",
		"\t<string>Background</string>",
		"</dict>",
		"</plist>",
	];
	return `${lines.join("\n")}\n`;
}

/** One argument as CommandLineToArgvW reads it back. */
function windowsArgument(value: string): string {
	if (value !== "" && !/[\s"]/u.test(value)) return value;
	let quoted = '"';
	let backslashes = 0;
	for (const character of value) {
		if (character === "\\") {
			backslashes += 1;
			continue;
		}
		if (character === '"') {
			quoted += `${"\\".repeat(backslashes * 2 + 1)}"`;
		} else {
			quoted += `${"\\".repeat(backslashes)}${character}`;
		}
		backslashes = 0;
	}
	return `${quoted}${"\\".repeat(backslashes * 2)}"`;
}

/**
 * A Task Scheduler task, not a service: node cannot answer the Service Control
 * Manager without a native wrapper. It starts at the user's logon with the
 * user's environment, restarts on failure and never times out.
 */
export function renderWindowsTask(argv: readonly string[]): string {
	const [program = "", ...args] = argv;
	const lines = [
		'<?xml version="1.0" encoding="UTF-8"?>',
		"<!-- Written by `hobo fleet service install`; register with",
		`     Register-ScheduledTask -TaskName ${SERVICE_NAME} -Xml (Get-Content -Raw <this file>).`,
		"     The task runs with the user's environment: set HOBO_FLEET_* with setx. -->",
		'<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
		"  <RegistrationInfo>",
		"    <Description>HoBo Fleet agent</Description>",
		`    <URI>\\HoBo\\${SERVICE_NAME}</URI>`,
		"  </RegistrationInfo>",
		"  <Triggers>",
		"    <LogonTrigger>",
		"      <Enabled>true</Enabled>",
		"    </LogonTrigger>",
		"  </Triggers>",
		"  <Principals>",
		'    <Principal id="Author">',
		"      <LogonType>InteractiveToken</LogonType>",
		"      <RunLevel>LeastPrivilege</RunLevel>",
		"    </Principal>",
		"  </Principals>",
		"  <Settings>",
		"    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
		"    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
		"    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
		"    <StartWhenAvailable>true</StartWhenAvailable>",
		"    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
		"    <RestartOnFailure>",
		"      <Interval>PT1M</Interval>",
		"      <Count>999</Count>",
		"    </RestartOnFailure>",
		"    <Hidden>true</Hidden>",
		"  </Settings>",
		'  <Actions Context="Author">',
		"    <Exec>",
		`      <Command>${xml(program)}</Command>`,
		`      <Arguments>${xml(args.map(windowsArgument).join(" "))}</Arguments>`,
		"    </Exec>",
		"  </Actions>",
		"</Task>",
	];
	return `${lines.join("\n")}\n`;
}
