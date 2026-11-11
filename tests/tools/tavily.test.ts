import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ToolCallOptions } from 'ai';
import { searchWeb } from '../../src/tools/tavily.ts';

// PRD §16.1 — Tavily web search — searchWeb, (searchWeb build) bullets only.

type SearchResult = { title: string; url: string; snippet: string; publishedDate: string };

const HAS_KEY = !!process.env.TAVILY_API_KEY;
const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_RECENCY_DAYS = 90;

// Minimum blocklist required by §16.1. The full list lives inline in src/tools/tavily.ts.
const REQUIRED_BLOCKED_DOMAINS = ['tipranks.com', 'seekingalpha.com', 'fool.com', 'benzinga.com'];

const callOptions = { toolCallId: 'test', messages: [] } satisfies ToolCallOptions;

async function search(input: { query: string; recencyDays?: number }): Promise<SearchResult[]> {
  return (await searchWeb.execute!(input, callOptions)) as SearchResult[];
}

function isBlocked(url: string, domains: string[]): boolean {
  const host = new URL(url).hostname.toLowerCase();
  return domains.some((d) => host === d || host.endsWith(`.${d}`));
}

function expectWithinWindow(results: SearchResult[], recencyDays: number) {
  // Small grace for clock skew / timezone-less dates at the window edge.
  const cutoff = Date.now() - recencyDays * DAY_MS - DAY_MS;
  for (const r of results) {
    const ts = Date.parse(r.publishedDate);
    expect(Number.isNaN(ts), `unparseable publishedDate: ${r.publishedDate} (${r.url})`).toBe(false);
    expect(ts, `${r.url} published ${r.publishedDate}, outside ${recencyDays}d window`).toBeGreaterThanOrEqual(cutoff);
  }
}

describe('Tavily — missing env (always runs)', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('throws a clear, actionable error when TAVILY_API_KEY is missing', async () => {
    vi.stubEnv('TAVILY_API_KEY', '');
    await expect(search({ query: 'Stripe' })).rejects.toThrow(/TAVILY_API_KEY/);
  });
});

if (!HAS_KEY) {
  console.warn('[skip] TAVILY_API_KEY unset — Tavily real-API suite skipped');
}

describe.skipIf(!HAS_KEY)('Tavily — real API', () => {
  let defaultResults: SearchResult[];

  beforeAll(async () => {
    // recencyDays omitted on purpose — exercises the default.
    defaultResults = await search({ query: 'Stripe' });
  }, 60_000);

  it('returns a non-empty result list for a normal query', () => {
    expect(Array.isArray(defaultResults)).toBe(true);
    expect(defaultResults.length).toBeGreaterThan(0);
  });

  it('returns results with exactly { title, url, snippet, publishedDate }', () => {
    expect(defaultResults.length).toBeGreaterThan(0);
    for (const r of defaultResults) {
      expect(Object.keys(r).sort()).toEqual(['publishedDate', 'snippet', 'title', 'url']);
      expect(typeof r.title).toBe('string');
      expect(typeof r.url).toBe('string');
      expect(typeof r.snippet).toBe('string');
      expect(typeof r.publishedDate).toBe('string');
    }
  });

  it(`defaults recencyDays to ${DEFAULT_RECENCY_DAYS} when the caller omits it`, () => {
    expect(defaultResults.length).toBeGreaterThan(0);
    expectWithinWindow(defaultResults, DEFAULT_RECENCY_DAYS);
  });

  it('only returns results with a parseable publishedDate inside an explicit recencyDays window', async () => {
    const recencyDays = 14;
    const results = await search({ query: 'OpenAI', recencyDays });
    expect(results.length).toBeGreaterThan(0);
    expectWithinWindow(results, recencyDays);
  });

  it('excludes results from blocklisted domains', async () => {
    // Stock-ticker news queries are where the finance-listicle domains surface most.
    const results = await search({ query: 'Nvidia stock analysis' });
    const leaked = results.filter((r) => isBlocked(r.url, REQUIRED_BLOCKED_DOMAINS)).map((r) => r.url);
    expect(leaked).toEqual([]);
  });
});
