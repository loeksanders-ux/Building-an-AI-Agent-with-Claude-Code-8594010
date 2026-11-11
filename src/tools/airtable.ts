import { experimental_createMCPClient, type experimental_MCPClient as MCPClient } from '@ai-sdk/mcp';

// Airtable hosted MCP (PRD §4.2): Streamable HTTP, not SSE (SSE returns 405).
const AIRTABLE_MCP_URL = 'https://mcp.airtable.com/mcp/';

// §12.3 — the CRUD primitives, looked up by exact name. No fuzzy matching.
const PRIMITIVES = [
  'list_tables_for_base',
  'list_records_for_table',
  'create_records_for_table',
  'update_records_for_table',
  'delete_records_for_table',
] as const;
type Primitive = (typeof PRIMITIVES)[number];

const TABLES = ['Prospects', 'Outreach'] as const;
type TableName = (typeof TABLES)[number];

type TableInfo = { id: string; fieldIds: Record<string, string> };
type McpTools = Awaited<ReturnType<MCPClient['tools']>>;

// Mirrors PRD §7.1. Replace with `import type { Prospect } from '../agent/research.ts'`
// once ProspectSchema lands in the (structurer + persistence) stage.
export type Prospect = {
  companyName: string;
  domain: string;
  overview: string;
  signals: { name: string; description: string; strength: 'strong' | 'moderate' | 'weak' }[];
  leadScore: number;
  scoreReasoning: string;
  suggestedAngle: string;
  lastResearched: string;
};

export interface AirtableMcp {
  tools: MCPClient['tools'];
  close(): Promise<void>;
  readonly baseId: string;
  readonly tables: Record<TableName, TableInfo>;
  call<T = unknown>(name: Primitive, args: Record<string, unknown>): Promise<T>;
}

function requireEnv(name: 'AIRTABLE_API_KEY' | 'AIRTABLE_BASE_ID', hint: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set. ${hint}`);
  return value;
}

// §12.3 envelope rule: isError:true arrives as a success-shaped object — throw on it.
async function invoke(tools: McpTools, name: Primitive, args: Record<string, unknown>): Promise<unknown> {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`Airtable MCP is missing the required "${name}" tool.`);
  const result = (await tool.execute(args, { toolCallId: name, messages: [] })) as {
    isError?: boolean;
    content?: { type: string; text?: string }[];
    structuredContent?: unknown;
  };
  const text = result.content?.find((c) => c.type === 'text')?.text;
  if (result.isError) throw new Error(`Airtable MCP "${name}" failed: ${text ?? 'unknown error'}`);
  return result.structuredContent ?? (text ? JSON.parse(text) : undefined);
}

/**
 * Opens the Airtable MCP client, verifies the pinned primitives exist, and resolves
 * table IDs + field-name → field-ID maps once. Caller must `close()` it (in `finally`).
 */
export async function getAirtableMcp(): Promise<AirtableMcp> {
  const apiKey = requireEnv('AIRTABLE_API_KEY', 'Set it to an Airtable personal access token (pat…) — see PRD §14.1.');
  const baseId = requireEnv('AIRTABLE_BASE_ID', 'Set it to the base ID (app…) from the Airtable base URL — see PRD §14.1.');

  const client = await experimental_createMCPClient({
    transport: { type: 'http', url: AIRTABLE_MCP_URL, headers: { Authorization: `Bearer ${apiKey}` } },
  });

  try {
    const tools = await client.tools();
    const missing = PRIMITIVES.filter((n) => !(n in tools));
    if (missing.length) {
      throw new Error(`Airtable MCP is missing required capabilities: ${missing.join(', ')} (see PRD §12.3).`);
    }

    const { tables: schema } = (await invoke(tools, 'list_tables_for_base', { baseId })) as {
      tables: { id: string; name: string; fields: { id: string; name: string }[] }[];
    };
    const tables = {} as Record<TableName, TableInfo>;
    for (const name of TABLES) {
      const t = schema.find((x) => x.name === name);
      if (!t) throw new Error(`Airtable base is missing the "${name}" table (see PRD §13).`);
      tables[name] = { id: t.id, fieldIds: Object.fromEntries(t.fields.map((f) => [f.name, f.id])) };
    }

    return {
      tools: () => client.tools(),
      close: () => client.close(),
      baseId,
      tables,
      call: async <T>(name: Primitive, args: Record<string, unknown>) =>
        (await invoke(tools, name, { baseId, ...args })) as T,
    };
  } catch (err) {
    await client.close().catch(() => {});
    throw err;
  }
}

function fieldId(client: AirtableMcp, table: TableName, field: string): string {
  const id = client.tables[table].fieldIds[field];
  if (!id) throw new Error(`Airtable "${table}" table is missing the "${field}" field (see PRD §13).`);
  return id;
}

type ListResult = { records: { id: string; cellValuesByFieldId: Record<string, unknown> }[] };

async function listProspectIdsByDomain(client: AirtableMcp, domain: string): Promise<string[]> {
  const { records } = await client.call<ListResult>('list_records_for_table', {
    tableId: client.tables.Prospects.id,
    fieldIds: [fieldId(client, 'Prospects', 'domain')],
    filters: { operator: 'and', operands: [{ operator: '=', operands: [fieldId(client, 'Prospects', 'domain'), domain] }] },
  });
  return records.map((r) => r.id);
}

function signalsToMarkdown(signals: Prospect['signals']): string {
  return signals.map((s) => `- **${s.name}** (${s.strength}): ${s.description}`).join('\n');
}

/** Insert or update the `Prospects` row keyed on `domain`. Returns the record ID. */
export async function upsertProspect(client: AirtableMcp, prospect: Prospect): Promise<string> {
  const f = (name: string) => fieldId(client, 'Prospects', name);
  const fields: Record<string, unknown> = {
    [f('domain')]: prospect.domain,
    [f('companyName')]: prospect.companyName,
    [f('overview')]: prospect.overview,
    [f('signals')]: signalsToMarkdown(prospect.signals),
    [f('leadScore')]: prospect.leadScore,
    [f('scoreReasoning')]: prospect.scoreReasoning,
    [f('suggestedAngle')]: prospect.suggestedAngle,
    [f('lastResearched')]: prospect.lastResearched,
  };
  const tableId = client.tables.Prospects.id;

  const matches = await listProspectIdsByDomain(client, prospect.domain);
  // Defensive guard (§12.3): >1 means the filter was dropped or duplicates exist.
  if (matches.length > 1) {
    throw new Error(`Expected at most one Prospects row for domain "${prospect.domain}", found ${matches.length}.`);
  }

  type WriteResult = { records: { id: string }[] };
  if (matches.length === 1) {
    // Status is left untouched on update — it may have moved past `researched`.
    await client.call<WriteResult>('update_records_for_table', { tableId, records: [{ id: matches[0], fields }] });
    return matches[0];
  }
  fields[f('status')] = 'researched';
  const { records } = await client.call<WriteResult>('create_records_for_table', { tableId, records: [{ fields }] });
  return records[0].id;
}

/** Read primitive. Returns the `rec…` ID of the `Prospects` row for `domain`, or null. */
export async function getProspectIdByDomain(client: AirtableMcp, domain: string): Promise<string | null> {
  const ids = await listProspectIdsByDomain(client, domain);
  if (ids.length > 1) throw new Error(`Expected at most one Prospects row for domain "${domain}", found ${ids.length}.`);
  return ids[0] ?? null;
}

/** Test cleanup helper. Deletes the `Prospects` row for `domain`; returns 0 or 1. */
export async function deleteProspectByDomain(client: AirtableMcp, domain: string): Promise<number> {
  const id = await getProspectIdByDomain(client, domain);
  if (!id) return 0;
  await client.call('delete_records_for_table', { tableId: client.tables.Prospects.id, recordIds: [id] });
  return 1;
}
