
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
