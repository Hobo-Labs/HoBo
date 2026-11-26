package hobo

// CUE constraints for Messaging plane wire records (ADR-0138).
// One constraint per protobuf message/enum in messaging_port.proto.

#DeliveryGuarantee: "at-least-once" | "exactly-once" | "at-most-once"

#ActorPlacementMode: "native" | "dapr" | "rivet" | "celld"

#TopicSpec: {
	name:               string & !=""
	tenant_id:          string & !=""
	project_id?:        string
	delivery:           #DeliveryGuarantee
	dead_letter_topic?: string
	schema_ref?:        string
	labels?:            {[string]: string}
}

#SubscriptionSpec: {
	name:                  string & !=""
	topic:                 string & !=""
	consumer_group:        string & !=""
	tenant_id:             string & !=""
	delivery:              #DeliveryGuarantee
	max_delivery_attempts: int & >=1 & <=1000
	dead_letter_topic?:    string
}

#MessagingSpec: {
	id:            string & !=""
	tenant_id:     string & !=""
	topics:        [...#TopicSpec]
	subscriptions: [...#SubscriptionSpec]
	backend:       string & !=""
}

#PublishRequest: {
	topic:             string & !=""
	key?:              string
	body_json:         string
	idempotency_key?:  string
	content_type?:     string
	headers?:          {[string]: string}
	tenant_id:         string & !=""
}

#PublishedMessage: {
	message_id:    string & !=""
	topic:         string & !=""
	partition_key: string
	offset:        int & >=0
	published_at:  string & !=""
	deduped:       bool
}

#ConsumedMessage: {
	message_id:       string & !=""
	topic:            string & !=""
	consumer_group:   string & !=""
	body_json:        string
	delivery_attempt: int & >=0
	lease_id:         string & !=""
	received_at:      string & !=""
	headers?:         {[string]: string}
}

#MessagingEventRecord: {
	type:            string & !=""
	topic:           string & !=""
	message_id?:     string
	consumer_group?: string
	tenant_id:       string & !=""
	reason?:         string
}
