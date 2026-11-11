import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getAirtableMcp } from '../../src/tools/airtable.ts';

// PRD §16.1 — Airtable MCP integration, (Airtable connector) bullets only.
// Later-stage wrappers (upsertProspect, getProspectIdByDomain, listOutreachByProspectId,
// createOutreach, delete*) are deliberately not tested here.

// §12.3 pins these by exact name. If this goes red, update §12.3 + §13.4 together —
// do not loosen to a fuzzy/"any write tool" check.
const PINNED_PRIMITIVES = [
  'list_tables_for_base',
  'list_records_for_table',
  'create_records_for_table',
  'update_records_for_table',
  'delete_records_for_table',
] as const;

const MISSING = ['AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'].filter((v) => !process.env[v]);
const HAS_ENV = MISSING.length === 0;

if (!HAS_ENV) {
  console.warn(`[skip] ${MISSING.join(', ')} unset — Airtable MCP real-API suite skipped`);
}

describe('Airtable MCP — missing env (always runs)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws a clear, actionable error naming AIRTABLE_API_KEY when it is missing', async () => {
    vi.stubEnv('AIRTABLE_API_KEY', '');
    vi.stubEnv('AIRTABLE_BASE_ID', 'appPlaceholder00000');
    await expect(getAirtableMcp()).rejects.toThrow(/AIRTABLE_API_KEY/);
  });

  it('throws a clear, actionable error naming AIRTABLE_BASE_ID when it is missing', async () => {
    vi.stubEnv('AIRTABLE_API_KEY', 'patPlaceholder');
    vi.stubEnv('AIRTABLE_BASE_ID', '');
    await expect(getAirtableMcp()).rejects.toThrow(/AIRTABLE_BASE_ID/);
  });
});

describe.skipIf(!HAS_ENV)('Airtable MCP — real API', () => {
  let client: Awaited<ReturnType<typeof getAirtableMcp>> | undefined;
  let closed = false;

  beforeAll(async () => {
    client = await getAirtableMcp();
  }, 60_000);

  afterAll(async () => {
    if (client && !closed) {
      try {
        await client.close();
      } catch (err) {
        console.warn('[cleanup] Airtable MCP client close failed:', err);
      }
    }
  }, 60_000);

  it('connects to the Airtable MCP server using AIRTABLE_API_KEY', async () => {
    expect(client).toBeDefined();
    const tools = await client!.tools();
    expect(Object.keys(tools).length).toBeGreaterThan(0);
  });

  it('discovers the five pinned CRUD primitives by exact name', async () => {
    const names = Object.keys(await client!.tools());
    for (const name of PINNED_PRIMITIVES) {
      expect(names, `missing pinned MCP primitive "${name}"`).toContain(name);
    }
  });

  it('closes cleanly via close()', async () => {
    await expect(client!.close()).resolves.not.toThrow();
    closed = true;
  });
});
