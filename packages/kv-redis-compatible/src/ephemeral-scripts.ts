
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

const PUT_IF_ABSENT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return false end
redis.call('HSET', KEYS[1], 'v', ARGV[1], 'i', ARGV[3], 'r', 1)
redis.call('PEXPIRE', KEYS[1], ARGV[2])
return ARGV[3] .. ':1'
`.trim();

const COMPARE_AND_SET = `
local cur = redis.call('HMGET', KEYS[1], 'i', 'r')
if not cur[1] or (cur[1] .. ':' .. cur[2]) ~= ARGV[1] then return false end
local r = redis.call('HINCRBY', KEYS[1], 'r', 1)
redis.call('HSET', KEYS[1], 'v', ARGV[2])
redis.call('PEXPIRE', KEYS[1], ARGV[3])
return cur[1] .. ':' .. r
`.trim();

const DELETE_IF_VERSION = `
local cur = redis.call('HMGET', KEYS[1], 'i', 'r')
if not cur[1] or (cur[1] .. ':' .. cur[2]) ~= ARGV[1] then return 0 end
return redis.call('DEL', KEYS[1])
`.trim();

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

export async function scriptSha1(body: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest(
		"SHA-1",
		new TextEncoder().encode(body),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
