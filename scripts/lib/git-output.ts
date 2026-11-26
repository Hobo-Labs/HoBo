/**
 * The most output, in bytes, a gate captures from one git command.
 *
 * `spawnSync` and `execFileSync` stop a child whose captured output passes 1
 * MiB and report ENOBUFS. A gate that reads `git ls-files` or
 * `git diff --name-only` then breaks the day the list outgrows that, with a
 * message about git instead of the buffer: `run-linters --all` failed that way
 * at a 1.4 MB tracked-file list. The bound is a ceiling, not a reservation; it
 * only has to stay far above any list a repository can hold.
 */
export const GIT_OUTPUT_MAX_BUFFER = 64 * 1024 * 1024;
