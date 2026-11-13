import fs from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, type StepResult } from 'ai';
import { searchWeb } from '../tools/tavily.ts';

// §12.2 — exploratory tools inside the loop. Preference tools join at (preferences wiring).
const tools = { searchWeb };

// Upper bound on loop steps. ai@^5 ignores `maxSteps` (§4.2) — stopWhen is the knob.
const MAX_STEPS = 10;

// (search wiring) shape per §12.3; narrows to { prospect, steps } at (structurer + persistence).
export type ResearchResult = { text: string; steps: StepResult<typeof tools>[] };

export async function researchCompany(companyName: string): Promise<ResearchResult> {
  // Checked up front: the SDK treats '' as a key and fails later with an opaque 401.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env (local) or your Codespaces secrets, then retry.',
    );
  }

  console.log(`Researching ${companyName}...`);

  const result = await generateText({
    model: anthropic('claude-haiku-4-5'),
    // Read per call (not at import) so prompt edits take effect without restarting.
    system: fs.readFileSync('src/agent/prompts/brain.md', 'utf8'),
    prompt: `Research the company "${companyName}" as a sales prospect. Summarize what it does and anything notable about it.`,
    tools,
    stopWhen: stepCountIs(MAX_STEPS),
    // §5.2 streaming trace — shows what the Brain actually decided.
    onStepFinish: ({ toolCalls, toolResults }) => {
      for (const call of toolCalls) console.log(`[tool]   ${call.toolName}(${JSON.stringify(call.input)})`);
      for (const r of toolResults) {
        const out = r.output as { url: string }[];
        const hosts = out.map((x) => new URL(x.url).hostname).join(', ');
        console.log(`[tool]   → ${out.length} results${hosts ? ` (${hosts})` : ''}`);
      }
    },
  });

  console.log('[brain]  final analysis ready');
  return { text: result.text, steps: result.steps };
}
