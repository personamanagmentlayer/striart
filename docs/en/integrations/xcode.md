# Xcode 26.3+

> [Documentation](../README.md) · [Integrations](README.md) · Xcode
> 🇫🇷 [Français](../../fr/integrations/xcode.md)

Xcode plays two roles that must not be confused:

1. **Xcode as an MCP server** (`xcrun mcpbridge`): Xcode exposes *its* tools
   to an external agent. Striart is not directly involved, but an agent
   driven by Striart can use it.
2. **Xcode as an agent host** (Claude Agent, Codex, Gemini, ACP agents):
   these agents can receive additional MCP servers — including `striart mcp`.

## Plugging Striart into an agent launched in Xcode

Apple documents that, for agents launched in Xcode, "you can set a default
model, add additional Model Context Protocol (MCP) servers, and create your
own skills", in one configuration folder per agent:

- `~/Library/Developer/Xcode/CodingAssistant/ClaudeAgentConfig`
- `~/Library/Developer/Xcode/CodingAssistant/codex`
- `~/Library/Developer/Xcode/CodingAssistant/gemini`

"These configurations only affect agents when you launch them in Xcode."
**Unverified**: Apple documents neither the name nor the format of the files
expected in these folders. They most likely follow each agent's native
format (for example `mcpServers` for Claude); check the agent's own
documentation before relying on it. The entry to declare is the same in all
cases: command `striart`, arguments `["mcp"]`.

**Working directory — unverified.** The server must start in the Git
repository of the project opened in Xcode. Since these folders are
**user-wide**, an entry without an explicit directory drives whichever
repository the agent's directory belongs to; if that is not guaranteed, use
add `--root <absolute path of the repository>` to the arguments (see the
[common page](README.md#choosing-the-driven-repository---root); one entry per
repository).

ACP agents: Xcode lets you add an ACP-compatible agent (Intelligence >
Agents > "Add an Agent"). Apple does not document the sheet's fields
(**unverified**). Striart is an ACP agent through `striart acp` (command
`striart`, argument `acp`): filling in that sheet has **not** been verified,
a real test is still to do.

## Using Xcode from an agent driven by Striart

For an agent (Claude Code, Codex) that Striart launched in a clone to reach
Xcode's tools:

1. Xcode > Settings > Intelligence > Model Context Protocol: turn on "Allow
   external agents to use Xcode tools";
2. on the agent side, e.g. `claude mcp add --transport stdio xcode -- xcrun mcpbridge`
   or `codex mcp add xcode -- xcrun mcpbridge`;
3. **open the clone's project in Xcode** (Apple: open your project before
   prompting the external agent). If the main repository's project is open,
   the agent would act through Xcode on the main repository, outside its
   clone — exactly what Striart is designed to prevent.

## What is covered

- Striart's tools for agents launched in Xcode, subject to each agent's own
  configuration format (unverified).

## Limits

- Configuration file format not documented by Apple.
- No documented per-project working directory.

## Security

- Xcode alerts you when an external agent connects and while it is active.
- Intelligence > Agents in Xcode > Permissions holds the "Allowed Commands"
  and "Allowed Tools" lists: only allow `striart_status` and `striart_queue`
  without confirmation.
- In organizations, the MDM key `CodingAssistantAllowExternalIntegrations`
  set to `false` disables external integrations.

## Sources (checked on 2026-10-24)

- Apple, "Giving external agents access to Xcode" —
  <https://developer.apple.com/documentation/xcode/giving-external-agents-access-to-xcode>
- Apple, "Extending and customizing agents" —
  <https://developer.apple.com/documentation/xcode/extending-and-customizing-agents>
- Apple, "Setting up coding intelligence" —
  <https://developer.apple.com/documentation/xcode/setting-up-coding-intelligence>

(No update date shown on these pages.)
