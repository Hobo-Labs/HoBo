/**
 * Where the runner protocol client's facts come from (ADR-0183).
 *
 * Every path, field and value the client sends or reads was read from the
 * open-source Actions runner, `actions/runner` (MIT), at the commit below. No
 * other implementation was read for it. A comment beside each field names the
 * file it came from, relative to `src/` in that repository.
 */

/** The `actions/runner` commit the protocol was read from. */
// public-contract: the actions/runner commit every protocol field was read from.
export const RUNNER_PROTOCOL_SOURCE_COMMIT =
	"af09a511a0869abf002daef236c66c5b146d683a";

/** The day it was read. */
// public-contract: the day the protocol was read.
export const RUNNER_PROTOCOL_SOURCE_READ_ON = "2026-11-17";

/**
 * The runner version the client reports (`src/runnerversion` at that commit).
 * The broker refuses a runner it thinks is too old (`RunnerVersionTooOld` in
 * `Sdk/RSWebApi/Contracts/BrokerErrorKind.cs`), so a bump is a commit here.
 */
// public-contract: the runner version the client reports to the service.
export const RUNNER_PROTOCOL_VERSION = "2.338.0";
