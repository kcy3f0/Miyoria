// Shared test fixtures.

export const SAMPLE = `# top comment
[core]
profile = "deepseek-chan"          # profiles/<id>/
database_url = "\${DATABASE_URL:-memory://}"

# ---- LLM ----
[llm.providers.deepseek]
kind = "deepseek"                  # deepseek | openai
api_key = "\${LLM_API_KEY:-}"

[llm.purposes]
chat = ["deepseek:deepseek-chat"]

# Admin API
[modules.api]
bind = "127.0.0.1:7878"
token = "\${MIYORIA_API_TOKEN:-}"

# voice link
[modules."voice.link"]
bind = "127.0.0.1:7879"
`;
