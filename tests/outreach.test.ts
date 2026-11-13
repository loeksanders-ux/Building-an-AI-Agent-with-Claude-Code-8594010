import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { draftOutreach, OutreachSchema, type Outreach } from '../src/agent/outreach.ts';
import type { Prospect } from '../src/agent/research.ts';
import {
  deleteOutreachByProspect,
  deleteProspectByDomain,
  getAirtableMcp,
  getProspectIdByDomain,
  listOutreachByProspectId,
  upsertProspect,
  type AirtableMcp,
} from '../src/tools/airtable.ts';

// PRD §16.1 — Outreach drafting — draftOutreach, (outreach drafting) bullets only.
// Behavior per §11.1 (schema), §11.2 (rules), §15 (errors). Airtable verification goes through the
// §12.3 read primitives; cleanup through the delete helpers (verifier ≠ cleaner).

const RUN_ENV = ['ANTHROPIC_API_KEY', 'AIRTABLE_API_KEY', 'AIRTABLE_BASE_ID'] as const;
const MISSING_RUN_ENV = RUN_ENV.filter((v) => !process.env[v]);
const CAN_RUN = MISSING_RUN_ENV.length === 0;

if (!CAN_RUN) {
  console.warn(`[skip] ${MISSING_RUN_ENV.join(', ')} unset — draftOutreach real-API suite skipped`);
}

const TEST_DOMAIN = 'outreachtestco';
const UNKNOWN_DOMAIN = 'outreachunknownco';

// Paraphrase-resistant match tokens (§16.1): numerals and proper nouns, one set per signal.
// They appear ONLY in signals[].description — never in companyName/overview/scoreReasoning/suggestedAngle.
const SIGNAL_TOKENS = [
  ['47', 'Singapore'],
  ['Busan', 'Korean'],
] as const;

const SEED: Prospect = {
  companyName: 'OutreachTestCo',
  domain: TEST_DOMAIN,
  overview:
    'OutreachTestCo is a mid-market e-commerce platform for consumer brands. It is growing quickly ' +
    'and pushing into new regional markets, with support demand rising alongside the expansion.',
  signals: [
    {
      name: 'Hiring activity',
      description: 'Posted 47 open customer support roles based in Singapore over the last quarter.',
      strength: 'strong',
    },
    {
      name: 'Market expansion',
      description: 'Launched a Korean-language storefront through a new Busan logistics partnership.',
      strength: 'strong',
    },
  ],
  leadScore: 78,
  scoreReasoning: 'Two strong expansion signals in the region; support volume is likely to spike soon.',
  suggestedAngle: 'Lead with scaling support alongside their new APAC launch and rapid regional hiring.',
  lastResearched: new Date().toISOString(),
};

// Guard the seed construction rule itself: no token may leak into a non-signal field.
function assertTokensOnlyInSignals(p: Prospect): void {
  const nonSignal = [p.companyName, p.overview, p.scoreReasoning, p.suggestedAngle, ...p.signals.map((s) => s.name)];
  for (const token of SIGNAL_TOKENS.flat()) {
    if (nonSignal.some((text) => text.includes(token))) {
      throw new Error(`Seed bug: match token "${token}" leaks outside signals[].description (§16.1).`);
    }
  }
}

const containsToken = (text: string, token: string) => new RegExp(`\\b${token}\\b`).test(text);

// §16 — each cleanup in its own try/catch; Outreach before Prospects (§12.3).
async function cleanup(client: AirtableMcp, domain: string): Promise<void> {
  try {
    await deleteOutreachByProspect(client, domain);
  } catch (err) {
    console.warn(`[cleanup] deleteOutreachByProspect(${domain}) failed: ${(err as Error).message}`);
  }
  try {
    await deleteProspectByDomain(client, domain);
  } catch (err) {
    console.warn(`[cleanup] deleteProspectByDomain(${domain}) failed: ${(err as Error).message}`);
  }
}

describe('Outreach — missing env (always runs)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws a clear, actionable error mentioning ANTHROPIC_API_KEY before any Airtable lookup', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    // Airtable env blanked too: an Airtable-first implementation would throw about AIRTABLE_* instead (§11.2).
    vi.stubEnv('AIRTABLE_API_KEY', '');
    vi.stubEnv('AIRTABLE_BASE_ID', '');
    await expect(draftOutreach(TEST_DOMAIN)).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe.skipIf(!CAN_RUN)('draftOutreach — real API (outreach drafting)', () => {
  // One real draftOutreach call per run, shared across assertions — cost control (§16).
  let client: AirtableMcp;
  let prospectId: string | null;
  let outreachBefore: string[];
  let outreach: Outreach;

  beforeAll(async () => {
    assertTokensOnlyInSignals(SEED);
    client = await getAirtableMcp();
    // Clear leftovers from an aborted earlier run so the persistence assertion starts from zero.
    await cleanup(client, TEST_DOMAIN);
    await cleanup(client, UNKNOWN_DOMAIN);

    await upsertProspect(client, SEED);
    prospectId = await getProspectIdByDomain(client, TEST_DOMAIN);
    outreachBefore = prospectId ? await listOutreachByProspectId(client, prospectId) : [];

    outreach = await draftOutreach(TEST_DOMAIN);
  }, 120_000);

  afterAll(async () => {
    if (client) await cleanup(client, TEST_DOMAIN);
    await client?.close().catch((err: Error) => console.warn(`[cleanup] close failed: ${err.message}`));
  }, 60_000);

  it('returns an object matching OutreachSchema (§11.1)', () => {
    const parsed = OutreachSchema.safeParse(outreach);
    expect(parsed.error).toBeUndefined();
    expect(parsed.success).toBe(true);
  });

  it('subjectLine is at most 80 characters', () => {
    expect(outreach.subjectLine.length).toBeLessThanOrEqual(80);
  });

  it('emailBody references at least two specific signals from the prospect record', () => {
    for (const tokens of SIGNAL_TOKENS) {
      const hit = tokens.some((t) => containsToken(outreach.emailBody, t));
      expect(hit, `emailBody references none of [${tokens.join(', ')}]:\n${outreach.emailBody}`).toBe(true);
    }
  });

  it('persists an Outreach row linked to the seeded prospect record id', async () => {
    // Verified via read primitives only — never deleteOutreachByProspect's count (§12.3).
    expect(prospectId).toMatch(/^rec/);
    expect(outreachBefore).toEqual([]);
    const after = await listOutreachByProspectId(client, prospectId!);
    expect(after.length).toBeGreaterThan(0);
  });

  it('errors with "Research <Company> first." for a domain with no prospect record', async () => {
    expect(await getProspectIdByDomain(client, UNKNOWN_DOMAIN)).toBeNull();
    await expect(draftOutreach(UNKNOWN_DOMAIN)).rejects.toThrow(/Research outreachunknownco first\./i);
  }, 60_000);
});
