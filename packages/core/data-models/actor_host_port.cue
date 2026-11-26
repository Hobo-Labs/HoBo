package data_models

#ActorLeaseRecord: {
	key:         string & !=""
	holder_id:   string & !=""
	fence_token: string & =~"^[0-9]+$"
	expires_at:  string & !=""
}

#FoldEventRecord: {
	type:         string & !=""
	payload_json: string
}

#ActorAppendResultRecord: {
	stream_id:   string & !=""
	seq:         uint64
	fence_token: string & =~"^[0-9]+$"
}
