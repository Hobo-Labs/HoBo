package core

#TaggedCacheEpoch: string & =~"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
#TaggedCacheTagEpochRecord: {
	tag:   string & !=""
	epoch: #TaggedCacheEpoch
}
#TaggedCacheEntryRecord: {
	value: string
	tagEpochs: [...#TaggedCacheTagEpochRecord]
}
#TaggedCacheReadRecord: {
	hit: bool
	if hit {
		value: string
	}
	if !hit {
		value?: string
	}
}

#CacheEntryRecord: {
	key:   string & =~"^[!-~]{1,512}$"
	value: #CacheBytes
	ttlMs: int & >0 & <=2592000000
	tags: [...string & !=""]
}
#CacheBytes: string & =~"^([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$"
#CacheInvalidateCommandRecord: {
	tag: string & !=""
}
#CacheReadRecord: {
	hit: bool
	if hit {
		value: #CacheBytes
	}
	if !hit {
		value?: #CacheBytes
	}
}
