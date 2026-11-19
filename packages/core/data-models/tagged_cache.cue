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
