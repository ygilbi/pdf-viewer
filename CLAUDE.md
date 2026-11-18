## Agent hygiene (added 2026-11-17, source: code.claude.com/docs/en/changelog v2.1.316–326)
- Subagents for search, scanning or reading files run at low effort. Set `effort` explicitly only for design, planning or review agents.
- Prefer a CLI command plus a short skill over an MCP server when a task uses 3 or fewer operations of that service.
- Never set `sandbox.autoAllowBashIfSandboxed: true` in this project.
- Install plugins and skills only from the original owner's repository, never from forks or mirror directories.
- Skills used by scheduled routines must not declare `allowed-tools` or hooks unless required, because the routine will stop and wait for approval.
- Do not report version numbers, stars or benchmark figures unless they appear in a primary source; say "unverified" otherwise.

## Tool economy (added 2026-11-18, source: openrouter.ai/blog/insights/mcp-vs-cli-vs-skills)
- If a well-known CLI exists for the service (gh, supabase, gcloud), use the CLI via Bash, not its MCP server.
- If an MCP server must be used, call only the tools the task needs and request minimal fields;
  never dump full list/search results into context.
- Prefer deferred tool loading (Tool Search) over loading every MCP tool at start.
- Measured on one GitHub task (Sonnet 5.5): CLI 1,421 tokens · MCP default 59,417 · MCP 2 tools + capped results 5,357.
