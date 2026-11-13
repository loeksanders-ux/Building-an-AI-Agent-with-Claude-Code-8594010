import fs from 'node:fs';
import { tool } from 'ai';
import { z } from 'zod';

const PREFS_PATH = 'src/memory/preferences.md';
const HEADER = '# Preferences\n\n';

function read(): string {
  return fs.existsSync(PREFS_PATH) ? fs.readFileSync(PREFS_PATH, 'utf8') : '';
}

function bulletText(line: string): string | null {
  return line.startsWith('- ') ? line.slice(2).trim() : null;
}

export const listPreferences = tool({
  description:
    "Read the user's saved preferences (how they want prospects analyzed and outreach written). " +
    'Call this first on every run and apply any preference that matches the prospect. ' +
    'Returns the preferences file as Markdown, or an empty string when nothing is saved yet.',
  inputSchema: z.object({}),
  execute: async (): Promise<string> => read(),
});

export const addPreference = tool({
  description:
    'Save a preference the user explicitly stated in their message (e.g. "for shipping companies always lead with X", ' +
    '"prefer subject lines under 50 characters"). Only call this for preferences the user asked to keep — never invent ' +
    'or infer one. Saving the same text twice is a no-op.',
  inputSchema: z.object({
    text: z.string().min(1).describe('The preference, stated as a single sentence.'),
  }),
  execute: async ({ text }): Promise<string> => {
    const pref = text.trim();
    const current = read();
    const lines = current.split('\n');
    if (lines.some((line) => bulletText(line) === pref)) {
      return `Preference already saved: ${pref}`;
    }
    const base = current === '' ? HEADER : current.endsWith('\n') ? current : `${current}\n`;
    fs.writeFileSync(PREFS_PATH, `${base}- ${pref}\n`);
    return `Saved preference: ${pref}`;
  },
});

export const removePreference = tool({
  description:
    'Remove a saved preference when the user asks to forget or drop one (e.g. "forget that multilingual rule"). ' +
    'Pass a distinctive fragment of the preference; matching is case-insensitive substring and only the first match is removed.',
  inputSchema: z.object({
    text: z.string().min(1).describe('A fragment of the preference to remove.'),
  }),
  execute: async ({ text }): Promise<string> => {
    const needle = text.trim().toLowerCase();
    const lines = read().split('\n');
    const index = lines.findIndex((line) => bulletText(line)?.toLowerCase().includes(needle) ?? false);
    if (index === -1) {
      return `No saved preference matches: ${text}`;
    }
    const removed = bulletText(lines[index]!);
    lines.splice(index, 1);
    fs.writeFileSync(PREFS_PATH, lines.join('\n'));
    return `Removed preference: ${removed}`;
  },
});
