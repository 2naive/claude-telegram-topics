// Per-run opt-out: TG_TOPICS_DISABLE=1 in the environment of ONE claude
// invocation keeps that run off the bridge entirely.
//
// Why: once the plugin is enabled, its MCP server and hooks run in EVERY
// claude process on the machine — including headless `claude -p` runs from
// cron jobs and scripts. Such a run joins (or wins) the leader election,
// registers its cwd as a project — a scratch dir like /tmp or a mktemp dir gets
// a brand-new topic — and its Stop hook mirrors the one-shot answer there.
// Inside a real project it posts into that project's topic instead, and its
// hook pings reset the live session's turn state. Deleting the junk topic
// doesn't help: the next mirror recreates it.
//
// Claude Code can already drop the plugin from one run with
//   --settings '{"enabledPlugins":{"telegram-topics@claude-telegram-topics":false}}'
// This switch does the same for the bridge but travels with the ENVIRONMENT:
// set once for a crontab, a service or a wrapper script, it reaches every
// nested `claude -p` without touching its command line.
//
// Honoured by every entry point Claude Code starts on its own: the MCP server
// (server.ts — no election, no registration, no tools, no channel capability)
// and both hooks (hooks/activity.ts, hooks/mirror.ts — no POST to the leader).
// Nothing that run does can then create, recreate or post into a topic.
//
// Environment-only by design: the channel .env is shared by every session, so
// a value there would mean "off everywhere" — that is what disabling the
// plugin is for. config.ts therefore never merges this key from the .env
// (which also keeps it out of the sessions a leader launches), and the hooks
// load nothing from the .env except TG_TOPICS_PORT (hooks/port.ts).
//
// Pure and import-free so a per-tool hook can load it without config.ts's
// load-time side effects (state-dir mkdir, .env merge).

export const OPT_OUT_ENV = "TG_TOPICS_DISABLE";

/**
 * True when the environment asks to keep this run off the bridge. Only an
 * exact "1" counts — the same rule as TG_TOPICS_AUTOSTART (spawn.ts
 * autostartEnabled), so "0", "false" or an empty value keep the default.
 */
export function optedOut(env: Record<string, string | undefined>): boolean {
  return env[OPT_OUT_ENV] === "1";
}
