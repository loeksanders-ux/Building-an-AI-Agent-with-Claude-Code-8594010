import fs from 'node:fs';
import { anthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';

export async function researchCompany(companyName: string): Promise<string> {
  // Checked up front: the SDK treats '' as a key and fails later with an opaque 401.
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error(
      'ANTHROPIC_API_KEY is not set. Add it to .env (local) or your Codespaces secrets, then retry.',
    );
  }

  const result = await generateText({
    model: anthropic('claude-haiku-4-5'),
    // Read per call (not at import) so prompt edits take effect without restarting.
    system: fs.readFileSync('src/agent/prompts/brain.md', 'utf8'),
    prompt: `Research the company "${companyName}" as a sales prospect. Summarize what it does and anything notable about it.`,
  });

  return result.text;
}
