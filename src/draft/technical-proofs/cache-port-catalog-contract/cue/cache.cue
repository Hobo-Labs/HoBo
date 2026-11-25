package cache

// CUE constraints for every ADR-0118 cache protobuf type. Parse, don't validate: these
// constraints turn the wire shapes into derived domain types (a value is either a valid
// #CacheEntry or it does not exist).

#CacheReadOutcome: "hit" | "miss"

#CacheEntry: {
	key!:        string & =~"^.{1,512}$"
	value!:      bytes
	ttlSeconds!: int & >0 & <=604800 // 1s .. 7d; required — a cache entry always expires
	tags?: [...string]
}

#CacheSetCommand: {
	entry!: #CacheEntry
}

#CacheInvalidateCommand: {
	tag!: string & =~"^.{1,128}$"
}
