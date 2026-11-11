import { tool } from 'ai';
import { z } from 'zod';

// SEO-spam finance listicles that surface for any company-name query and add zero support-fit signal.
const BLOCKED_DOMAINS = [
  'tipranks.com',
  'seekingalpha.com',
  'fool.com',
  'benzinga.com',
  'marketbeat.com',
  'zacks.com',
];

const MAX_RESULTS = 5;
const DEFAULT_RECENCY_DAYS = 90;
const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';
const DAY_MS = 24 * 60 * 60 * 1000;

type SearchResult = { title: string; url: string; snippet: string; publishedDate: string };

type TavilyRawResult = {
  title?: string;
  url?: string;
  content?: string;
  published_date?: string | null;
};

function isBlocked(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true; // unparseable URL — nothing the Brain can cite
  }
  return BLOCKED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`));
}

export const searchWeb = tool({
  description:
    'Search recent news about a company (funding, launches, hiring, leadership changes, support/CX initiatives). ' +
    'Use this to find concrete, dated buying signals when researching a sales prospect. ' +
    `Returns up to ${MAX_RESULTS} results with title, url, snippet, and publishedDate. ` +
    `recencyDays limits results to the last N days (default ${DEFAULT_RECENCY_DAYS}).`,
  inputSchema: z.object({
    query: z.string(),
    recencyDays: z.number().int().positive().optional(),
  }),
  execute: async ({ query, recencyDays = DEFAULT_RECENCY_DAYS }): Promise<SearchResult[]> => {
    const apiKey = process.env.TAVILY_API_KEY;
    if (!apiKey) {
      throw new Error(
        'TAVILY_API_KEY is not set. Add it as a Codespaces secret or to .env in the project root (see .env.example).',
      );
    }

    const res = await fetch(TAVILY_SEARCH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        query,
        topic: 'news', // only news-topic searches reliably populate published_date
        days: recencyDays,
        max_results: MAX_RESULTS,
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(
        `Tavily search failed: ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ''}. ` +
          'Check your key, quota, and rate limits on the Tavily dashboard.',
      );
    }

    const data = (await res.json()) as { results?: TavilyRawResult[] };
    const cutoff = Date.now() - recencyDays * DAY_MS;

    return (data.results ?? []).flatMap((r): SearchResult[] => {
      if (!r.url || !r.published_date) return [];
      const ts = Date.parse(r.published_date);
      if (Number.isNaN(ts) || ts < cutoff) return [];
      if (isBlocked(r.url)) return [];
      return [{ title: r.title ?? '', url: r.url, snippet: r.content ?? '', publishedDate: r.published_date }];
    });
  },
});
