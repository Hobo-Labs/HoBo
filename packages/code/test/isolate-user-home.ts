/**
 * Give every test worker a throwaway HOME.
 *
 * The root's `test/setup/isolate-hobo-home.ts` (also in this package's setup)
 * gives each file its own HOBO_HOME, but that only covers code that reads
 * HOBO_HOME. `resolveHoboHome` falls back to `os.homedir()` for an environment
 * with no HOME, and other code here reads `~/.codex`, `~/.claude` or a git
 * config under HOME. Left alone, all of that is the developer's real home, and
 * a suite run left chats, an auth session and evidence in `~/.hobo`.
 *
 * `os.homedir()` returns `process.env.HOME` when it is set, so setting HOME
 * here moves every in-process lookup. The directory is one per worker inside
 * the run's root (the root's `test/setup/hobo-test-homes.ts` makes and
 * removes it), so state
 * still cannot leak between runs. A child process given an environment with
 * no HOME falls back to the account's home instead; the guard reports that.
 *
 * Git refuses to commit without an identity, and the developer's
 * `~/.gitconfig` is no longer read, so the home carries one of its own.
 * `test/isolate-git-env.ts` points this process's git at no global config
 * (`GIT_CONFIG_GLOBAL=/dev/null`), so it serves only a child spawned with an
 * environment of its own that keeps HOME but not that setting. It is the
 * lowest-precedence config: a test that sets `user.name` in its repository
 * still gets that name.
 */
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOMES_ROOT_ENV } from "../../../test/setup/hobo-test-homes.js";

const root = process.env[HOMES_ROOT_ENV];
const worker = process.env.VITEST_POOL_ID ?? String(process.pid);
const home = root
	? join(root, `user-${worker}`)
	: mkdtempSync(join(tmpdir(), "hobo-code-test-user-"));
mkdirSync(home, { recursive: true });
const gitconfig = join(home, ".gitconfig");
if (!existsSync(gitconfig))
	writeFileSync(
		gitconfig,
		"[user]\n\tname = HoBo Test\n\temail = test@hobo.invalid\n",
	);
process.env.HOME = home;
