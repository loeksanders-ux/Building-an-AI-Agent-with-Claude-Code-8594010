import { afterEach, describe, expect, it, vi } from 'vitest';
import { researchCompany } from '../../src/agent/research.ts';

// PRD §16.1 — Company research — researchCompany, (researchCompany seed) + (search wiring) bullets.
// (search wiring) widens the return to { text, steps } per §12.3; the seed test is rewired to
// .text, not dropped. (structurer + persistence) will narrow it to { prospect, steps }.

const HAS_KEY = !!process.env.ANTHROPIC_API_KEY;
const HAS_TAVILY = !!process.env.TAVILY_API_KEY;

describe('researchCompany — missing env (always runs)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws a clear, actionable error when ANTHROPIC_API_KEY is missing', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await expect(researchCompany('Stripe')).rejects.toThrow(/ANTHROPIC_API_KEY/);
  });
});

if (!HAS_KEY) {
  console.warn('[skip] ANTHROPIC_API_KEY unset — researchCompany real-API suite skipped');
}

describe.skipIf(!HAS_KEY)('researchCompany — real API (researchCompany seed)', () => {
  it('is callable and returns a non-empty response for a company name', async () => {
    const { text } = await researchCompany('Stripe');
    expect(typeof text).toBe('string');
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});

if (HAS_KEY && !HAS_TAVILY) {
  console.warn('[skip] TAVILY_API_KEY unset — researchCompany (search wiring) suite skipped');
}

describe.skipIf(!HAS_KEY || !HAS_TAVILY)('researchCompany — real API (search wiring)', () => {
  it('invokes searchWeb at least once during a run', async () => {
    const { steps } = await researchCompany('Stripe');
    expect(steps.length).toBeGreaterThan(1);
    const toolNames = steps.flatMap((s) => s.toolCalls.map((c) => c.toolName));
    expect(toolNames).toContain('searchWeb');
  }, 120_000);
});
