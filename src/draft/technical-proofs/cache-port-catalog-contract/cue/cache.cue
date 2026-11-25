package cache


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
