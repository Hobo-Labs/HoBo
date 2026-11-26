package architecture_evidence

import "strings"
import "time"

#LeaseInfo: {
	key:         string & !=""
	holder_id:   string & !=""
	fence_token: int & >0
	expires_at:  string & strings.IsISO8601
}

#ActorEventRecord: {
	stream_id:   string & !=""
	seq:         int & >0
	type:        string & !=""
	fence_token: int & >0
	holder_id:   string & !=""
	appended_at: string & strings.IsISO8601
	payload:     bytes
}

#AppendReceipt: {
	stream_id:   string & !=""
	seq:         int & >0
	fence_token: int & >0
}

#ActorStateSnapshot: {
	stream_id:    string & !=""
	snapshot_seq: int & >=0
	saved_at:     string & strings.IsISO8601
}

#ActorHostConfig: {
	lease_ttl_ms: int & >0
}
