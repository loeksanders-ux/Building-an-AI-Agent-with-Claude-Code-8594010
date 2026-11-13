import fs from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import { generateObject, generateText, stepCountIs, type StepResult } from 'ai';
import { z } from 'zod';
import { addPreference, listPreferences, removePreference } from '../memory/preferences.ts';
import { getAirtableMcp, upsertProspect, type AirtableMcp } from '../tools/airtable.ts';
import { searchWeb } from '../tools/tavily.ts';

// §7.1 — the structured shape every research output must match.
export const ProspectSchema = z.object({
  companyName: z.string(),
  domain: z.string(), // canonical key — set by caller, not the model. See §7.4.
  overview: z.string(),
  signals: z
    .array(
      z.object({
        name: z.string(),
        description: z.string(),
        strength: z.enum(['strong', 'moderate', 'weak']),
      }),
    )
    .min(1),
  leadScore: z.number().int().min(1).max(100),
  scoreReasoning: z.string(),
  suggestedAngle: z.string(),
  lastResearched: z.string().datetime(), // ISO 8601, set by caller
});

export type Prospect = z.infer<typeof ProspectSchema>;

// §7.4 — the model gets no slot for the load-bearing key or the caller-set timestamp.
const StructuredSchema = ProspectSchema.omit({ domain: true, lastResearched: true });
export type StructuredProspect = z.infer<typeof StructuredSchema>;

// §12.1 — exploratory tools inside the loop; the Brain decides which to call and when.
const tools = { searchWeb, listPreferences, addPreference, removePreference };

// Upper bound on loop steps. ai@^5 ignores `maxSteps` (§4.2) — stopWhen is the knob.
// Preference reads/saves add ~2 tool calls per run on top of the searches.
const MAX_STEPS = 8;

// §15 — schema validation failure on agent output: retry up to 2 times, then error.
const STRUCTURE_RETRIES = 2;

// §12.3 final shape. Do not flatten to Prospect, do not add fields.
export type ResearchResult = { prospect: Prospect; steps: StepResult<typeof tools>[] };

/**
 * §12.3 — free-text analysis → typed partial. Prompt pinned verbatim; returns the partial
 * as-is (no domain / lastResearched — the caller attaches both, §7.4).
 */
export async function structureProspect(analysisText: string, companyName: string): Promise<StructuredProspect> {
  const { object } = await generateObject({
    model: anthropic('claude-haiku-4-5'),
    schema: StructuredSchema,
    prompt: `Extract a structured prospect for ${companyName} from the analysis below. Every field must come from the analysis text — do not invent values. Each signal's \`strength\` must be one of: strong, moderate, weak.

Analysis:
${analysisText}`,
  });
  return object;
}

/**
 * §6 / §7.4 — canonical key from the input name: lowercase alphanumerics only; a domain
 * input (stripe.com, https://www.stripe.com/x) has protocol, www. and TLD stripped first.
 */
function normalizeDomain(companyName: string): string {
  let name = companyName.trim().toLowerCase();
  const host = name.replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0];
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host)) name = host.split('.')[0];
  return name.replace(/[^a-z0-9]/g, '');
}

export async function researchCompany(companyName: string): Promise<ResearchResult> {
  // Checked up front: the SDK treats '' as a key and fails later with an opaque 401.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env (local) or your Codespaces secrets, then retry.',
    );
  }

  // §12.3 — MCP client opened at the top of researchCompany, closed in finally.
  const airtable = await getAirtableMcp();
  try {
    return await runResearch(companyName, airtable);
  } finally {
    await airtable.close();
  }
}

async function runResearch(
  companyName: string,
  airtable: AirtableMcp,
): Promise<ResearchResult> {
  console.log(`Researching ${companyName}...`);

  const result = await generateText({
    model: anthropic('claude-haiku-4-5'),
    // Read per call (not at import) so prompt edits take effect without restarting.
    system: fs.readFileSync('src/agent/prompts/brain.md', 'utf8'),
    prompt: `Research the company "${companyName}" as a sales prospect. Summarize what it does and anything notable about it.`,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    // §10.4 — read preferences first, every run. The prompt asks for this, but Haiku
    // sometimes jumps straight to searchWeb, so the opening order is pinned in code:
    // step 0 must be listPreferences, step 1 must be searchWeb; after that the Brain chooses.
    prepareStep: ({ stepNumber }) => {
      if (stepNumber === 0) return { toolChoice: { type: 'tool', toolName: 'listPreferences' } };
      if (stepNumber === 1) return { toolChoice: { type: 'tool', toolName: 'searchWeb' } };
      return undefined;
    },
    // §5.2 streaming trace — shows what the Brain actually decided.
    onStepFinish: ({ text, toolCalls, toolResults }) => {
      // Only intermediate narration — the final step's text is the returned analysis.
      if (text.trim() && toolCalls.length) console.log(`[brain]  ${text.trim()}`);
      for (const call of toolCalls) console.log(`[tool]   ${call.toolName}(${JSON.stringify(call.input)})`);
      for (const r of toolResults) {
        // Preference tools return strings; only searchWeb returns a result list.
        if (r.toolName !== 'searchWeb') {
          const out = String(r.output).trim();
          console.log(`[tool]   → ${out ? out.split('\n')[0] : '(empty)'}`);
          continue;
        }
        const out = r.output as { url: string }[];
        const hosts = out.map((x) => new URL(x.url).hostname).join(', ');
        console.log(`[tool]   → ${out.length} results${hosts ? ` (${hosts})` : ''}`);
      }
    },
  });

  console.log('[brain]  final analysis ready');

  // §12.1 — deterministic, outside the loop: structure → attach → validate → persist.
  const domain = normalizeDomain(companyName);
  let prospect: Prospect | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt <= STRUCTURE_RETRIES && !prospect; attempt++) {
    try {
      const partial = await structureProspect(result.text, companyName);
      prospect = ProspectSchema.parse({ ...partial, domain, lastResearched: new Date().toISOString() });
    } catch (err) {
      lastError = err;
      console.log(`[code]   structuring attempt ${attempt + 1} failed: ${(err as Error).message.split('\n')[0]}`);
    }
  }
  if (!prospect) {
    throw new Error(
      `Could not structure the analysis for ${companyName} after ${STRUCTURE_RETRIES + 1} attempts: ${(lastError as Error)?.message}`,
    );
  }
  console.log(`[code]   structured prospect: ${prospect.domain} (score ${prospect.leadScore})`);

  try {
    const recordId = await upsertProspect(airtable, prospect);
    console.log(`[code]   upserted Prospects row ${recordId}`);
  } catch (err) {
    // §15 — surface the error, but print the prospect so the work isn't lost.
    console.log(`[code]   Airtable write failed — prospect follows:\n${JSON.stringify(prospect, null, 2)}`);
    throw err;
  }

  return { prospect, steps: result.steps };
}
