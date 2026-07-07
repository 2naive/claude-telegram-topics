#!/usr/bin/env bun
// MCP stdio server exposed to Claude Code.
//
// Thin and transparent: tools relay to/from this project's Telegram topic via
// the leader. Inbound content is passed through verbatim — no editorializing of
// reactions, no autonomous model calls (sampling). What you see is what the
// user actually sent.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { existsSync } from "node:fs";
import { assertConfigured } from "./config.ts";
import { assertSendable } from "./access.ts";
import * as channel from "./client.ts";
import type { Inbound } from "./leader.ts";

function format(m: Inbound): string {
  if (m.type === "message") return `[${m.from}] ${m.text}`;
  if (m.type === "callback") return `[${m.from}] chose: ${m.data}`;
  return `[${m.from}] reacted: ${m.emoji}`;
}

function ok(text: string) {
  return { content: [{ type: "text" as const, text }] };
}

const server = new McpServer({ name: "telegram-topics", version: "0.1.0" });

server.registerTool(
  "send_message",
  {
    description:
      "Send a message to this project's Telegram topic. Does not wait for a reply. Use for progress updates, notifications, or final results.",
    inputSchema: { text: z.string().describe("Message text (Markdown supported)") },
  },
  async ({ text }) => {
    const id = await channel.send(text);
    return ok(`sent (message ${id})`);
  },
);

server.registerTool(
  "ask_user",
  {
    description:
      "Send a message to this project's Telegram topic and wait up to 5 minutes for the user's reply. Optionally offer buttons. Returns the user's reply verbatim (text, chosen button, or reaction).",
    inputSchema: {
      question: z.string().describe("The question or message to send"),
      options: z
        .array(z.string())
        .optional()
        .describe("Optional buttons, e.g. [\"Yes\", \"No\"]"),
    },
  },
  async ({ question, options }) => {
    await channel.send(question, options);
    const reply = await channel.nextMessage(300);
    return ok(reply ? format(reply) : "[timeout: no reply within 5 minutes]");
  },
);

server.registerTool(
  "check_messages",
  {
    description:
      "Return any messages the user has sent to this project's topic since the last check. Non-blocking.",
    inputSchema: {},
  },
  async () => {
    const msgs = await channel.drainMessages();
    return ok(msgs.length ? msgs.map(format).join("\n") : "no new messages");
  },
);

server.registerTool(
  "wait_for_message",
  {
    description:
      "Block until the user sends the next message to this project's topic (up to 25 minutes). Use for continuous back-and-forth over Telegram.",
    inputSchema: {},
  },
  async () => {
    const reply = await channel.nextMessage(1500);
    return ok(reply ? format(reply) : "[timeout: no message]");
  },
);

server.registerTool(
  "send_file",
  {
    description:
      "Send a file from an absolute local path to this project's topic. Images send as photos; other files as documents.",
    inputSchema: {
      path: z.string().describe("Absolute path to the file"),
      caption: z.string().optional().describe("Optional caption"),
    },
  },
  async ({ path, caption }) => {
    if (!existsSync(path)) return ok(`error: file not found: ${path}`);
    assertSendable(path); // refuse to leak channel state (token)
    const id = await channel.sendFile(path, caption ?? "");
    return ok(`file sent (message ${id})`);
  },
);

server.registerTool(
  "react",
  {
    description:
      "Add an emoji reaction to a message in this project's topic. Only Telegram's fixed reaction set is accepted (👍 👎 ❤ 🔥 👀 …).",
    inputSchema: {
      message_id: z.number().describe("Target message id"),
      emoji: z.string().describe("A single allowed reaction emoji"),
    },
  },
  async ({ message_id, emoji }) => {
    await channel.react(message_id, emoji);
    return ok("reacted");
  },
);

server.registerTool(
  "edit_message",
  {
    description:
      "Edit a message this bot previously sent (e.g. turn a 'working…' note into the result). Only the bot's own messages can be edited.",
    inputSchema: {
      message_id: z.number().describe("Message id to edit"),
      text: z.string().describe("New text"),
    },
  },
  async ({ message_id, text }) => {
    await channel.edit(message_id, text);
    return ok("edited");
  },
);

async function main() {
  try {
    assertConfigured();
  } catch (e) {
    process.stderr.write(String(e) + "\n");
    process.exit(1);
  }
  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`telegram-topics: fatal: ${e}\n`);
  process.exit(1);
});
