/* Slash-command registry + pure parsing helpers for the chat input.
   Framework-agnostic so it can be unit-tested without a DOM. The InputDock renders
   the autocomplete menu from these defs and dispatches by name; the store owns the
   side effects (see actions.runSlashCommand). */

export type SlashArgKind = "none" | "model";

export interface SlashCommandDef {
  /** Canonical name, without the leading slash. */
  name: string;
  /** Alternate names that resolve to the same command. */
  aliases?: string[];
  /** One-line description shown in the autocomplete menu. */
  summary: string;
  /** Display hint including any argument, e.g. "/model <name>". */
  usage?: string;
  /** Whether the command consumes a trailing argument. */
  arg?: SlashArgKind;
}

export const SLASH_COMMANDS: SlashCommandDef[] = [
  { name: "clear", aliases: ["new"], summary: "Start a fresh conversation" },
  { name: "compact", summary: "Compact history to reclaim context" },
  { name: "model", summary: "Switch the active model", usage: "/model <name>", arg: "model" },
  { name: "retry", summary: "Resend your last message" },
  { name: "settings", summary: "Open the settings panel" },
  { name: "history", summary: "Browse past conversations" },
  { name: "help", summary: "List every slash command" },
];

/** True when the text is (the start of) a slash command — leading "/" and no whitespace before it. */
export function isSlashInput(text: string): boolean {
  return /^\/[^\s]*/.test(text);
}

/**
 * While the user is still typing the command name (no space yet), return the partial
 * name so the menu can filter. Returns "" for a bare "/". Returns null once an argument
 * is being typed (a space follows the name) or when the text isn't a slash command.
 */
export function slashQuery(text: string): string | null {
  const m = /^\/([^\s]*)$/.exec(text);
  return m ? m[1]! : null;
}

/** Split a submitted slash command into its name (lowercased) and trailing argument. */
export function parseSlashInput(text: string): { name: string; arg: string } | null {
  const m = /^\/([a-zA-Z][\w-]*)\s*([\s\S]*)$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), arg: m[2]!.trim() };
}

/** Resolve a name or alias (case-insensitive) to its command definition. */
export function resolveSlashCommand(name: string): SlashCommandDef | null {
  const n = name.trim().toLowerCase();
  if (!n) return null;
  return SLASH_COMMANDS.find((c) => c.name === n || (c.aliases?.includes(n) ?? false)) ?? null;
}

/** Filter the registry by a partial name/alias prefix, ranked prefix-first. */
export function matchSlashCommands(query: string): SlashCommandDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SLASH_COMMANDS];
  const scored = SLASH_COMMANDS
    .map((c) => {
      const names = [c.name, ...(c.aliases ?? [])];
      let score = 0;
      for (const name of names) {
        if (name === q) score = Math.max(score, 3);
        else if (name.startsWith(q)) score = Math.max(score, 2);
        else if (name.includes(q)) score = Math.max(score, 1);
      }
      return { c, score };
    })
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.c.name.localeCompare(b.c.name));
  return scored.map((e) => e.c);
}

/** The canonical `/usage` string for display. */
export function slashUsage(def: SlashCommandDef): string {
  return def.usage ?? `/${def.name}`;
}
