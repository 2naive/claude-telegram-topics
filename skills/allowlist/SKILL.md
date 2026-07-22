---
name: allowlist
description: Put this plugin on the Claude Code channels allowlist (managed settings) so `--channels` delivers inbound messages — one command, one admin prompt. Use when preflight reports NOT ALLOWLISTED, when Telegram messages never arrive in sessions although the send tools work, or when the user asks to set up the channels allowlist.
user-invocable: true
allowed-tools:
  - Bash(bun run *)
---

# Allowlist the channel

`--channels` wires a channel ONLY for plugins on the approved-channels
allowlist; anything else is **silently** loaded as a plain MCP plugin —
outbound tools work, inbound never arrives. This skill approves the plugin in
machine-level managed settings. Run:

```bash
bun run --cwd "${CLAUDE_PLUGIN_ROOT}" allowlist
```

(If `${CLAUDE_PLUGIN_ROOT}` is not substituted, the plugin root is the
installed plugin directory, e.g.
`~/.claude/plugins/cache/claude-telegram-topics/telegram-topics/<version>`.)

What it does, verbatim from its output:

- **already allowlisted** — nothing to change; done.
- **Windows** — writes `C:\Program Files\ClaudeCode\managed-settings.json`;
  if not elevated it raises **one UAC prompt** the user must approve at the
  machine.
- **macOS / Linux** — writes the managed-settings path or, on permission
  denied, prints the exact `sudo` command for the user to run themselves.
- The write is **merge-safe** (existing managed-settings keys and allowlist
  entries are preserved) and also carries the official Telegram plugin's
  entry, because a custom `allowedChannelPlugins` REPLACES the default
  Anthropic allowlist.

After a successful write, tell the user to **restart their Claude Code
sessions** — the allowlist is read at session start.

## No-admin alternative

Without machine admin rights the channel can still run via the development
flag, which bypasses the allowlist:

```
claude --permission-mode auto --dangerously-load-development-channels plugin:telegram-topics@claude-telegram-topics
```

Trade-off: an interactive "local development" confirmation gates **every**
start — fine for hand-started sessions, unusable for hands-off remote
relaunch/autostart. Mention it when the user cannot (or does not want to)
approve the admin write.
