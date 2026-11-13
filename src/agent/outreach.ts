import fs from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject } from 'ai';
import { z } from 'zod';
import { createOutreach, getAirtableMcp, getProspectByDomain, type ProspectRecord } from '../tools/airtable.ts';

// §11.1
export const OutreachSchema = z.object({
  subjectLine: z.string().max(80),
  emailBody: z.string(),
  angleReasoning: z.string(),
});

export type Outreach = z.infer<typeof OutreachSchema>;

const PREFS_PATH = 'src/memory/preferences.md';
const PROMPT_PATH = 'src/agent/prompts/outreach.md';

// §15 — schema validation failure on agent output: retry up to 2 times, then error.
const DRAFT_RETRIES = 2;

/**
 * §12.4 — one-shot draft: prospect + preferences read in code, a single generateObject call
 * (no loop, no tools), then persisted to `Outreach` via createOutreach.
 */
export async function draftOutreach(domain: string): Promise<Outreach> {
  // §11.2 — env first, before any Airtable lookup, prompt load, or model call. '' counts as missing.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set. Add it to .env (local) or your Codespaces secrets, then retry.');
  }

  const airtable = await getAirtableMcp();
  try {
    const prospect = await getProspectByDomain(airtable, domain);
    if (!prospect) {
      // §15 — the record holds the display name; with no record, the domain is all we have.
      throw new Error(`Research ${domain} first. No prospect record found.`);
    }
    console.log(`[code]   loaded prospect ${prospect.id} (${String(prospect.companyName ?? domain)})`);

    // §10 / §12.4 — memory read in code; a missing file means no preferences.
    const preferences = fs.existsSync(PREFS_PATH) ? fs.readFileSync(PREFS_PATH, 'utf8') : '';
    // §11.4 — drafting rules live in the prompt file. Read per call so edits apply immediately.
    const system = fs.readFileSync(PROMPT_PATH, 'utf8');

    const outreach = await generateDraft(system, buildPrompt(prospect, preferences));
    console.log(
      `[code]   draft ready\n\nSubject: ${outreach.subjectLine}\n\n${outreach.emailBody}\n\nAngle reasoning: ${outreach.angleReasoning}\n`,
    );

    // §11.3 — persisted in code after generateObject returns. The draft is already printed above,
    // so a failed write does not lose the work (§15).
    const recordId = await createOutreach(airtable, prospect.id, outreach);
    console.log(`[code]   created Outreach row ${recordId}`);
    return outreach;
  } finally {
    await airtable.close();
  }
}

async function generateDraft(system: string, prompt: string): Promise<Outreach> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= DRAFT_RETRIES; attempt++) {
    try {
      const { object } = await generateObject({ model: anthropic('claude-haiku-4-5'), schema: OutreachSchema, system, prompt });
      return OutreachSchema.parse(object);
    } catch (err) {
      lastError = err;
      console.log(`[code]   drafting attempt ${attempt + 1} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  throw new Error(`Could not draft outreach after ${DRAFT_RETRIES + 1} attempts: ${(lastError as Error)?.message}`);
}

function buildPrompt(p: ProspectRecord, preferences: string): string {
  const field = (name: string) => String(p[name] ?? '').trim() || '(none)';
  return `Draft a first-touch outreach email for this prospect.

## Prospect record

- Company: ${field('companyName')}
- Overview: ${field('overview')}
- Signals:
${field('signals')}
- Lead score: ${field('leadScore')}
- Score reasoning: ${field('scoreReasoning')}
- Suggested angle: ${field('suggestedAngle')}

## Preferences

${preferences.trim() || '(none saved)'}`;
}
