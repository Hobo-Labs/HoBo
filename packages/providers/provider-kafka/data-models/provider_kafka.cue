package hobo

// CUE constraints for Kafka capability provider wire records (ADR-0138).
// One constraint per protobuf message/enum in provider_kafka.proto.
// Parse, don't validate: derived domain types are produced by parseKafka* parsers.

#KafkaClusterKind:
	"self-hosted" | "redpanda" | "msk" | "confluent" | "azure-event-hubs" | "local-emulator"

#KafkaClusterSpec: {
	name:                   string & !=""
	tenant_id:              string & !=""
	kind:                   #KafkaClusterKind
	bootstrap_servers:      [...string]
	credential_binding_ref: string // secretless — never plaintext
	transactional:          bool
	idempotent_producer:    bool
	schema_registry_ref?:   string
	labels?:                {[string]: string}
}

#KafkaTopicResource: {
	name:                string & !=""
	cluster:             string & !=""
	tenant_id:           string & !=""
	partitions:          int & >=1
	replication_factor:  int & >=1
	delivery_guarantee:  "at-least-once" | "exactly-once" | "at-most-once"
	dead_letter_topic?:  string
	schema_ref?:         string
}

#KafkaResourceDefinition: {
	api_version: "hobo.kafka/v1"
	kind:        "KafkaCluster" | "KafkaTopic"
	name:        string & !=""
	tenant_id:   string & !=""
	body_json:   string
}

#KafkaDoctorReport: {
	redpanda_available: bool
	brokers_reachable:  bool
	fidelity:           "simulated" | "live"
	notes:              [...string]
	remediation:        [...string]
}
