{
  "consumer": { "name": "{{name}}-web" },
  "provider": { "name": "{{name}}-api" },
  "interactions": [
    {
      "description": "web fetches a greeting",
      "request": { "method": "GET", "path": "/hello" },
      "response": {
        "status": 200,
        "headers": { "content-type": "application/json" },
        "body": { "message": "howdy, world", "greetingPrefix": "howdy" }
      }
    }
  ],
  "metadata": { "pactSpecification": { "version": "3.0.0" } }
}
