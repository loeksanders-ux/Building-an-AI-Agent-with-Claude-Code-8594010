import fs from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText, stepCountIs, type StepResult } from 'ai';
import { addPreference, listPreferences, removePreference } from '../memory/preferences.ts';
import { searchWeb } from '../tools/tavily.ts';

// §12.1 — exploratory tools inside the loop; the Brain decides which to call and when.
const tools = { searchWeb, listPreferences, addPreference, removePreference };

// Upper bound on loop steps. ai@^5 ignores `maxSteps` (§4.2) — stopWhen is the knob.
// Preference reads/saves add ~2 tool calls per run on top of the searches.
const MAX_STEPS = 8;

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
  return { text: result.text, steps: result.steps };
}
