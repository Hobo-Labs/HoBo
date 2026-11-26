// CUE constraints for every protobuf type in agent_skills.proto, so the
// architecture guard can confirm the skills-manifest shapes are bounded at
// parse time.

package agent_skills

#SkillManifestEntry: {
	name:        string & !=""
	description: string & !=""
	entry:       string & !=""
}

#SkillsManifest: {
	schema: "hobo.agent-skills-manifest/v1"
	skills: [...#SkillManifestEntry]
}
