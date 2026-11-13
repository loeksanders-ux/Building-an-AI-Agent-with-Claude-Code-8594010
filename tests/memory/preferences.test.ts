import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolCallOptions } from 'ai';
import { addPreference, listPreferences, removePreference } from '../../src/memory/preferences.ts';

// PRD §16.1 — Preferences memory, (preferences memory) bullets only.
// (preferences wiring) bullets — researchCompany calling these tools — land with that stage.
// Real file, no mocks. No env vars required, so nothing here skips.

const PREFS_PATH = 'src/memory/preferences.md';
const callOptions = { toolCallId: 'test', messages: [] } satisfies ToolCallOptions;

// The three are tool()-wrapped (§10.3), so tests drive them through execute like the Brain does.
async function list(): Promise<string> {
  return (await listPreferences.execute!({}, callOptions)) as string;
}
async function add(text: string): Promise<unknown> {
  return addPreference.execute!({ text }, callOptions);
}
async function remove(text: string): Promise<unknown> {
  return removePreference.execute!({ text }, callOptions);
}

function bullets(content: string): string[] {
  return content
    .split('\n')
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim());
}

describe('Preferences memory (preferences memory)', () => {
  // Snapshot whatever the user had saved, start each test from no file, restore afterwards.
  let original: string | null;

  beforeEach(() => {
    original = fs.existsSync(PREFS_PATH) ? fs.readFileSync(PREFS_PATH, 'utf8') : null;
    fs.rmSync(PREFS_PATH, { force: true });
  });

  afterEach(() => {
    if (original === null) fs.rmSync(PREFS_PATH, { force: true });
    else fs.writeFileSync(PREFS_PATH, original);
  });

  it('listPreferences returns "" when the file does not exist', async () => {
    expect(await list()).toBe('');
  });

  it('listPreferences returns the file contents as a string', async () => {
    const content = '# Preferences\n\n- Prefer subject lines under 50 characters.\n';
    fs.writeFileSync(PREFS_PATH, content);
    expect(await list()).toBe(content);
  });

  it('addPreference creates the file with a # Preferences header on first write', async () => {
    await add('Prefer subject lines under 50 characters.');
    expect(fs.existsSync(PREFS_PATH)).toBe(true);
    const content = fs.readFileSync(PREFS_PATH, 'utf8');
    expect(content.trimStart().startsWith('# Preferences')).toBe(true);
    expect(bullets(content)).toEqual(['Prefer subject lines under 50 characters.']);
  });

  it('addPreference appends a new bullet and round-trips through listPreferences', async () => {
    await add('Prefer subject lines under 50 characters.');
    await add("Always include the prospect's recent hiring trajectory in the overview section.");
    const content = await list();
    expect(content).toBe(fs.readFileSync(PREFS_PATH, 'utf8'));
    expect(bullets(content)).toEqual([
      'Prefer subject lines under 50 characters.',
      "Always include the prospect's recent hiring trajectory in the overview section.",
    ]);
  });

  it('addPreference is idempotent on exact match', async () => {
    await add('Prefer subject lines under 50 characters.');
    await add('Prefer subject lines under 50 characters.');
    expect(bullets(await list())).toEqual(['Prefer subject lines under 50 characters.']);
  });

  it('removePreference removes a bullet by case-insensitive substring match', async () => {
    await add('Prefer subject lines under 50 characters.');
    await add('For shipping companies, lead with multilingual deflection across Cantonese and Bahasa.');
    await remove('CANTONESE AND BAHASA');
    expect(bullets(await list())).toEqual(['Prefer subject lines under 50 characters.']);
  });

  it('removePreference removes only the first match when several match', async () => {
    await add('Lead with multilingual deflection for shipping companies.');
    await add('Lead with multilingual deflection for airlines.');
    await remove('multilingual deflection');
    expect(bullets(await list())).toEqual(['Lead with multilingual deflection for airlines.']);
  });
});
