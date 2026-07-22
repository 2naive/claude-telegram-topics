// Channels-allowlist detection and managed-settings merge.
//
// `--channels` wires a channel ONLY for plugins on the approved-channels
// allowlist; anything else is silently loaded as a plain MCP plugin — outbound
// tools work, inbound never arrives (the worst first-run failure: everything
// LOOKS healthy). This fork is not on Anthropic's default allowlist, so it
// must be approved via managed settings. This module is the single source of
// truth for "are we allowlisted?" — used by the setup preflight, the
// /telegram-topics:allowlist skill, and the leader's undelivered-message
// notice (so the silent failure names its own cause).

import { existsSync, readFileSync } from "node:fs";

export type ChannelPluginEntry = { plugin: string; marketplace: string };

export type ManagedSettings = Record<string, unknown> & {
  channelsEnabled?: boolean;
  allowedChannelPlugins?: ChannelPluginEntry[];
};

export const OUR_ENTRY: ChannelPluginEntry = {
  plugin: "telegram-topics",
  marketplace: "claude-telegram-topics",
};

// allowedChannelPlugins REPLACES the default Anthropic allowlist, so writing
// only our own entry would break the official Telegram plugin for users who
// also run it — always carry the official entry along.
export const OFFICIAL_ENTRY: ChannelPluginEntry = {
  plugin: "telegram",
  marketplace: "claude-plugins-official",
};

/** Where Claude Code reads machine-level managed settings (per its own docs;
 * on Windows a HKLM\SOFTWARE\Policies\ClaudeCode registry policy also exists —
 * not inspected here). */
export function managedSettingsPath(): string {
  if (process.platform === "win32") {
    return "C:\\Program Files\\ClaudeCode\\managed-settings.json";
  }
  if (process.platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  return "/etc/claude-code/managed-settings.json";
}

export type AllowlistState = { ok: boolean; detail: string };

/** Is this plugin approved for `--channels` on this machine? */
export function channelAllowlistState(file = managedSettingsPath()): AllowlistState {
  try {
    if (!existsSync(file)) {
      return { ok: false, detail: `no managed settings at ${file}` };
    }
    const parsed = JSON.parse(readFileSync(file, "utf8")) as ManagedSettings;
    if (parsed.channelsEnabled === false) {
      return { ok: false, detail: `channelsEnabled is false in ${file}` };
    }
    const list = Array.isArray(parsed.allowedChannelPlugins)
      ? parsed.allowedChannelPlugins
      : [];
    const ours = list.some(
      (l) => l && l.plugin === OUR_ENTRY.plugin && l.marketplace === OUR_ENTRY.marketplace,
    );
    return ours
      ? { ok: true, detail: `allowlisted in ${file}` }
      : {
          ok: false,
          detail: `${file} has no ${OUR_ENTRY.plugin}@${OUR_ENTRY.marketplace} entry in allowedChannelPlugins`,
        };
  } catch (e) {
    return { ok: false, detail: `managed settings unreadable (${file}): ${e}` };
  }
}

/**
 * Merge the allowlist into existing managed settings without clobbering: every
 * foreign key and existing allowlist entry is preserved; our entry and the
 * official plugin's entry are appended if absent; channelsEnabled is forced on
 * (a channel allowlist with channels disabled would be self-defeating).
 */
export function mergeManagedSettings(existing: unknown): ManagedSettings {
  const base: ManagedSettings =
    existing && typeof existing === "object" && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  const list: ChannelPluginEntry[] = Array.isArray(base.allowedChannelPlugins)
    ? [...base.allowedChannelPlugins]
    : [];
  const has = (e: ChannelPluginEntry): boolean =>
    list.some((l) => l && l.plugin === e.plugin && l.marketplace === e.marketplace);
  for (const e of [OUR_ENTRY, OFFICIAL_ENTRY]) {
    if (!has(e)) list.push(e);
  }
  base.allowedChannelPlugins = list;
  base.channelsEnabled = true;
  return base;
}
