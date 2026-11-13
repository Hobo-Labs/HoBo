# Service installers (L10)

`installService(platform, argv)` writes a definition that runs `argv` as a service for the current user. `argv` is the command line, with an absolute program path first. The function returns `Outcome<string>`, whose value is the path it wrote. If a definition already exists at that path, it is replaced. The function does not enable the service. The caller shows the person the command and runs it:

| Platform | Definition | Enable with |
|---|---|---|
| `linux` | systemd user unit `$XDG_CONFIG_HOME/systemd/user/hobo-fleet.service` (default `~/.config`) | `systemctl --user enable --now hobo-fleet` |
| `darwin` | launchd agent `~/Library/LaunchAgents/dev.hobo.fleet.plist` | `launchctl bootstrap gui/$(id -u) <path>` |
| `win32` | Task Scheduler XML at `%USERPROFILE%\AppData\Local\hobo\hobo-fleet.xml` | `Register-ScheduledTask -TaskName hobo-fleet -Xml (Get-Content -Raw <path>)` |

Each definition restarts the agent when it fails and gives it 120 seconds to drain when it stops. The systemd and launchd definitions record the agent's `HOBO_FLEET_*` variables of §6.15 that are set at install time. They never record `HOBO_FLEET_NATS_SERVER_BIN`, which is for tests only. A Windows task runs with the user's own environment.

**Windows is a scheduled task, not a service.** Node cannot answer the Service Control Manager without a native wrapper. The task starts when the user logs on and runs with least privilege.

The installer refuses (`invalid-request`):

- an empty command line;
- a program path that is not absolute (a drive-letter or UNC path on Windows);
- an argument that contains a control character;
- an argument that looks like a bootstrap token (`hft_…`), under rule 11.

Each definition is checked against a fixture in `test/install/fixtures/`.
