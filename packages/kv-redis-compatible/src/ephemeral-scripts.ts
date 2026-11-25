/**
 * The Lua scripts behind the ephemeral-state port on a Redis-protocol store.
 *
 * One script per conditional write, so each port call is one atomic server
 * round trip. They are plain Redis 5+ Lua over hashes and run unchanged on
 * Redis, Valkey, and any REST-fronted store that executes `EVAL`/`EVALSHA`,
 * which is the whole reason the REST and TCP bindings share semantics.
 *
 * Storage layout, per key: a hash with
 *   `v` — the value (a decimal string for a counter),
 *   `i` — the incarnation: a token chosen by the writer that created the key,
 *   `r` — the revision, 1 on create and +1 on every write.
 * The version token handed to callers is `<i>:<r>`. `r` alone would repeat
 * after a delete-and-recreate (ABA); the incarnation does not.
 *
 * A key holding anything other than such a hash (a plain string, a list) makes
 * `HMGET` fail with `WRONGTYPE`, which the binding surfaces as a rejected call.
 */

export type EphemeralScriptName =
	| "putIfAbsent"
	| "compareAndSet"
	| "deleteIfVersion"
	| "increment"
	| "getMany";

export type EphemeralScript = {
	readonly name: EphemeralScriptName;
	readonly body: string;
};

/** KEYS[1]; ARGV: value, ttlMs, incarnation. Returns the version, or nil when the key exists. */
const PUT_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'i', ARGV[3], 'r', 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return ARGV[3] .. ':1'
`.trim();

/** KEYS[1]; ARGV: expectedVersion, value, ttlMs. Returns the new version, or nil on mismatch. */
const COMPARE_AND_SET = `
local cur = redis.call('HMGET', KEYS[1], 'i', 'r')
if not cur[1] or (cur[1] .. ':' .. cur[2]) ~= ARGV[1] then return false end
local r = redis.call('HINCRBY', KEYS[1], 'r', 1)
redis.call('HSET', KEYS[1], 'v', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return cur[1] .. ':' .. r
`.trim();

/** KEYS[1]; ARGV: expectedVersion. Returns 1 when deleted, 0 on mismatch or absence. */
const DELETE_IF_VERSION = `
local cur = redis.call('HMGET', KEYS[1], 'i', 'r')
if not cur[1] or (cur[1] .. ':' .. cur[2]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`.trim();

/**
 * KEYS[1]; ARGV: by, ttlMs, incarnation, mode ("on-create" | "refresh").
 * Returns the new integer value. HINCRBY rejects a non-integer `v`, so a
 * counter can never silently reset a value written by putIfAbsent.
 */
const INCREMENT = `
local created = redis.call('EXISTS', KEYS[1]) == 0
local n = redis.call('HINCRBY', KEYS[1], 'v', ARGV[1])
if created then
  redis.call('HSET', KEYS[1], 'i', ARGV[3], 'r', 1)
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  redis.call('HINCRBY', KEYS[1], 'r', 1)
  if ARGV[4] == 'refresh' then redis.call('PEXPIRE', KEYS[1], ARGV[2]) end
end
return n
`.trim();

/**
 * KEYS[1..n]. Returns an index-aligned array of {value, version} or nil.
 * `false` (not nil) marks an absent key, because a Lua nil would truncate the
 * array at the first missing entry.
 */
const GET_MANY = `
local out = {}
for idx, k in ipairs(KEYS) do
  local h = redis.call('HMGET', k, 'v', 'i', 'r')
  if h[2] then out[idx] = {h[1], h[2] .. ':' .. h[3]} else out[idx] = false end
end
return out
`.trim();

export const EPHEMERAL_SCRIPTS: Readonly<
	Record<EphemeralScriptName, EphemeralScript>
> = Object.freeze({
	putIfAbsent: { name: "putIfAbsent", body: PUT_IF_ABSENT },
	compareAndSet: { name: "compareAndSet", body: COMPARE_AND_SET },
	deleteIfVersion: { name: "deleteIfVersion", body: DELETE_IF_VERSION },
	increment: { name: "increment", body: INCREMENT },
	getMany: { name: "getMany", body: GET_MANY },
});

/**
 * SHA-1 of a script body, lowercase hex — the `EVALSHA` handle.
 *
 * WebCrypto rather than `node:crypto`, so the module loads unchanged in an
 * edge runtime as well as in Node.
 */
export async function scriptSha1(body: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(body),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
