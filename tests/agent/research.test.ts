import fs from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProspectSchema, researchCompany, structureProspect, type Prospect } from '../../src/agent/research.ts';
import { deleteProspectByDomain, getAirtableMcp, type AirtableMcp } from '../../src/tools/airtable.ts';

// PRD §16.1 — Company research — researchCompany: (researchCompany seed), (search wiring),
// (structurer + persistence) bullets. The return shape is now { prospect, steps } per §12.3;
// the seed and search-wiring tests are rewired to it, not dropped.
// PRD §16.1 — Preference-driven agent behavior, (preferences wiring) bullets. The two
// suggestedAngle bullets are also (structurer + persistence) but are not in this change.
//
// Every researchCompany run now upserts to Airtable, so every real-API suite that calls it
// requires ANTHROPIC + TAVILY + AIRTABLE env and cleans up the rows it writes (§16).

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const RUN_ENV = ['ANTHROPIC_API_KEY', 'TAVILY_API_KEY', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'] as const;
const MISSING_RUN_ENV = RUN_ENV.filter((v) => !process.env[v]);
const CAN_RUN = MISSING_RUN_ENV.length === 0;

const PREFS_PATH = 'src/memory/preferences.md';

if (!HAS_KEY) {
  console.warn('[skip] ANTHROPIC_API_KEY unset — structureProspect real-API suite skipped');
}
if (!CAN_RUN) {
  console.warn(
    `[skip] ${MISSING_RUN_ENV.join(', ')} unset — researchCompany real-API suites skipped ` +
      `(seed, search wiring, preferences wiring, structurer + persistence require ${RUN_ENV.join(', ')})`,
  );
}

// §16 — each cleanup in its own try/catch; cleanups log, assertions decide.
async function cleanupProspects(domains: string[]): Promise<void> {
  let client: AirtableMcp | undefined;
  try {
    client = await getAirtableMcp();
    for (const domain of domains) {
      try {
        await deleteProspectByDomain(client, domain);
      } catch (err) {
        console.warn(`[cleanup] deleteProspectByDomain(${domain}) failed: ${(err as Error).message}`);
      }
    }
  } catch (err) {
    console.warn(`[cleanup] getAirtableMcp failed: ${(err as Error).message}`);
  } finally {
    await client?.close().catch((err: Error) => console.warn(`[cleanup] close failed: ${err.message}`));
  }
}

// The Brain may read or write the real preferences.md — snapshot and restore it.
function snapshotPrefs(): string | null {
  return fs.existsSync(PREFS_PATH) ? fs.readFileSync(PREFS_PATH, 'utf8') : null;
}
function restorePrefs(original: string | null): void {
  try {
    if (original === null) fs.rmSync(PREFS_PATH, { force: true });
    else fs.writeFileSync(PREFS_PATH, original);
  } catch (err) {
    console.warn(`[cleanup] restoring ${PREFS_PATH} failed: ${(err as Error).message}`);
  }
}

describe('researchCompany — missing env (always runs)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws a clear, actionable error when ANTHROPIC_API_KEY is missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(researchCompany('Stripe')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe.skipIf(!CAN_RUN)('researchCompany — real API (researchCompany seed)', () => {
  let originalPrefs: string | null;
  beforeEach(() => {
    originalPrefs = snapshotPrefs();
  });
  afterEach(() => restorePrefs(originalPrefs));
  afterAll(() => cleanupProspects(['stripe']), 60_000);

  it('is callable and returns a non-empty response for a company name', async () => {
    const { prospect } = await researchCompany('Stripe');
    expect(typeof prospect.overview).toBe('string');
    expect(prospect.overview.trim().length).toBeGreaterThan(0);
  }, 120_000);
});

describe.skipIf(!CAN_RUN)('researchCompany — real API (search wiring + preferences wiring)', () => {
  let originalPrefs: string | null;
  beforeEach(() => {
    originalPrefs = snapshotPrefs();
  });
  afterEach(() => restorePrefs(originalPrefs));
  afterAll(() => cleanupProspects(['stripe', 'fedex']), 60_000);

  it('invokes searchWeb at least once during a run', async () => {
    const { steps } = await researchCompany('Stripe');
    expect(steps.length).toBeGreaterThan(1);
    const toolNames = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    expect(toolNames).toContain('searchWeb');
  }, 120_000);

  // (preferences wiring) acceptance test — pins listPreferences in the tools map and the
  // "read preferences first, every run" rule (§10.4).
  it('begins with a listPreferences tool call', async () => {
    const { steps } = await researchCompany('Stripe');
    const firstCall = steps[0]?.toolCalls[0]?.toolName as string | undefined;
    expect(firstCall).toBe('listPreferences');
  }, 120_000);

  it('saves stateful feedback from the user message via addPreference in the same run', async () => {
    // Start from no file so a pre-existing preference cannot satisfy the file assertion.
    fs.rmSync(PREFS_PATH, { force: true });

    const { steps } = await researchCompany(
      'Research FedEx. For shipping companies, always lead with multilingual deflection across Cantonese and Bahasa.',
    );

    const toolNames = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName as string));
    expect(toolNames).toContain('addPreference');

    // Paraphrase-resistant tokens (§16.1) — proves the user's preference, not an invented one, was saved.
    expect(fs.existsSync(PREFS_PATH)).toBe(true);
    const saved = fs.readFileSync(PREFS_PATH, 'utf8');
    expect(saved).toMatch(/Cantonese/);
    expect(saved).toMatch(/Bahasa/);
  }, 120_000);
});

describe.skipIf(!HAS_KEY)('structureProspect — real API (structurer + persistence)', () => {
  const ANALYSIS = [
    'Stripe is a payments infrastructure company serving online businesses from startups to enterprises.',
    'It recently announced an expansion of its stablecoin payments product into 101 countries and is',
    'hiring 40+ support engineers in Dublin. Public reviews mention slow support response times for',
    'mid-market merchants. Overall a promising prospect, roughly 72/100, best approached via support scale.',
  ].join(' ');

  // §7.4 negative test — the structurer has no slot for domain or lastResearched.
  it('returns an object without domain or lastResearched keys', async () => {
    const partial = await structureProspect(ANALYSIS, 'Stripe');
    expect(partial).toBeTypeOf('object');
    expect(Object.keys(partial)).not.toContain('domain');
    expect(Object.keys(partial)).not.toContain('lastResearched');
    expect('domain' in partial).toBe(false);
    expect('lastResearched' in partial).toBe(false);
  }, 60_000);
});

describe.skipIf(!CAN_RUN)('researchCompany — real API (structurer + persistence)', () => {
  // One full pipeline run (loop → structurer → upsert) shared across the assertions — cost control (§16).
  let prospect: Prospect;
  let client: AirtableMcp;
  let originalPrefs: string | null;

  beforeAll(async () => {
    originalPrefs = snapshotPrefs();
    ({ prospect } = await researchCompany('Stripe'));
    client = await getAirtableMcp();
  }, 120_000);

  afterAll(async () => {
    restorePrefs(originalPrefs);
    try {
      if (client && prospect) await deleteProspectByDomain(client, prospect.domain);
    } catch (err) {
      console.warn(`[cleanup] deleteProspectByDomain failed: ${(err as Error).message}`);
    }
    await client?.close().catch((err: Error) => console.warn(`[cleanup] close failed: ${err.message}`));
  }, 60_000);

  it('returns an object matching ProspectSchema (§7.1)', () => {
    const parsed = ProspectSchema.safeParse(prospect);
    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('leadScore is an integer in [1, 100]', () => {
    expect(Number.isInteger(prospect.leadScore)).toBe(true);
    expect(prospect.leadScore).toBeGreaterThanOrEqual(1);
    expect(prospect.leadScore).toBeLessThanOrEqual(100);
  });

  it('signals is non-empty and every strength is strong | moderate | weak', () => {
    expect(prospect.signals.length).toBeGreaterThan(0);
    for (const s of prospect.signals) {
      expect(['strong', 'moderate', 'weak']).toContain(s.strength);
    }
  });

  it('domain is canonical: lowercase, no protocol, no TLD', () => {
    expect(prospect.domain).toBe('stripe');
    expect(prospect.domain).toMatch(/^[a-z0-9]+$/);
  });

  it('is compatible with the Prospects Airtable schema (§13.2)', () => {
    const fieldIds = client.tables.Prospects.fieldIds;
    for (const key of Object.keys(prospect)) {
      expect(fieldIds[key], `Prospects table has no "${key}" field`).toBeDefined();
    }
    for (const key of ['domain', 'companyName', 'overview', 'scoreReasoning', 'suggestedAngle'] as const) {
      expect(typeof prospect[key]).toBe('string');
    }
    expect(Array.isArray(prospect.signals)).toBe(true); // rendered to Markdown for the rich-text field
    expect(Number.isInteger(prospect.leadScore)).toBe(true);
    expect(Number.isNaN(Date.parse(prospect.lastResearched))).toBe(false);
  });

  it('persists exactly one Prospects row whose values match the returned prospect', async () => {
    const f = client.tables.Prospects.fieldIds;
    const [domainF, leadScoreF, companyNameF, lastResearchedF] = [f.domain, f.leadScore, f.companyName, f.lastResearched];

    // Structured `filters` per §12.3 — never filterByFormula (silently dropped).
    const { records } = await client.call<{ records: { id: string; cellValuesByFieldId: Record<string, unknown> }[] }>(
      'list_records_for_table',
      {
        tableId: client.tables.Prospects.id,
        fieldIds: [domainF, leadScoreF, companyNameF, lastResearchedF],
        filters: { operator: 'and', operands: [{ operator: '=', operands: [domainF, prospect.domain] }] },
      },
    );

    expect(records).toHaveLength(1);
    // Values off cellValuesByFieldId — r.fields[name] is undefined on this MCP surface (§12.3).
    const cells = records[0].cellValuesByFieldId;
    expect(cells[domainF]).toBe(prospect.domain);
    expect(cells[leadScoreF]).toBe(prospect.leadScore);
    expect(cells[companyNameF]).toBe(prospect.companyName);
    // Same instant; Airtable may drop sub-second precision on datetime cells.
    const stored = Date.parse(String(cells[lastResearchedF]));
    expect(Math.abs(stored - Date.parse(prospect.lastResearched))).toBeLessThan(1000);
  });
});
