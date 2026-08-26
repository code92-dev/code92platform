// agent-tick: the one piece of InsForge scheduling this whole subsystem needs.
//
//   InsForge schedule "agent-tick"  (*/5 * * * *)  →  this function
//
// It does two jobs on each firing:
//
//   1. Drains pending agent_runs — the retry path for mentions whose direct ping
//      from the Server Action failed or never arrived.
//   2. Fires due agent_schedules by queueing a run for each, then advancing that
//      schedule's clock.
//
// Scheduling lives in public.agent_schedules rather than in InsForge's
// schedules.jobs because that table is not writable by our roles (see the note in
// trend-scan.ts), and because owning it here is better anyway: RLS decides who
// may schedule, budgets are per agent, and every job has its own kill switch.
//
/* eslint-disable @typescript-eslint/no-explicit-any */

import { createAdminClient } from 'npm:@insforge/sdk';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// Matches the switch in thread-agent.ts. Off here means schedules stop firing but
// the InsForge schedule keeps making one cheap no-op call per slot.
const PIPELINE_ENABLED = true;

const MAX_SCHEDULES_PER_TICK = 10;
const MAX_DRAIN_PER_TICK = 10;
// How far ahead to search for the next cron match before giving up. A schedule
// that matches nothing inside three months is a typo, and saying so is more
// useful than looping to the heat death of the universe.
const CRON_SEARCH_MINUTES = 60 * 24 * 90;

// ============================================================
// Cron
// ============================================================
// Five fields: minute hour day-of-month month day-of-week. Supports *, lists,
// ranges and steps — the subset a human actually types. Everything is evaluated
// in UTC, which is what the database stores and what the schedule editor says.

function parseField(field: string, min: number, max: number): Set<number> {
  const out = new Set<number>();

  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number(stepPart) : 1;
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`bad step in cron field: ${part}`);
    }

    let lo: number;
    let hi: number;

    if (rangePart === '*') {
      lo = min;
      hi = max;
    } else if (rangePart.includes('-')) {
      const [a, b] = rangePart.split('-').map(Number);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        throw new Error(`bad range in cron field: ${part}`);
      }
      lo = a;
      hi = b;
    } else {
      const v = Number(rangePart);
      if (!Number.isInteger(v)) throw new Error(`bad value in cron field: ${part}`);
      lo = v;
      hi = v;
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron field out of range (${min}-${max}): ${part}`);
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }

  return out;
}

type Cron = {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
};

function parseCron(expr: string): Cron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error('cron must have five fields: minute hour day month weekday');
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    // 0 and 7 both mean Sunday, as everywhere else cron is written.
    dow: parseField(fields[4].replace(/7/g, '0'), 0, 6),
    domRestricted: fields[2] !== '*',
    dowRestricted: fields[4] !== '*',
  };
}

function matches(c: Cron, d: Date): boolean {
  if (!c.minute.has(d.getUTCMinutes())) return false;
  if (!c.hour.has(d.getUTCHours())) return false;
  if (!c.month.has(d.getUTCMonth() + 1)) return false;

  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());

  // Standard cron oddity: when BOTH day fields are restricted they are OR'd, not
  // AND'd. Getting this wrong makes "0 9 1 * 1" fire far too rarely.
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

function nextRun(expr: string, after: Date, minGapMinutes: number): Date {
  const c = parseCron(expr);

  // The floor is whichever is later: one minute past `after`, or the minimum gap.
  // min_interval_minutes exists so a cron that resolves tighter than intended
  // cannot turn into a billing event.
  const start = new Date(after.getTime() + Math.max(1, minGapMinutes) * 60_000);
  start.setUTCSeconds(0, 0);

  const cursor = new Date(start);
  for (let i = 0; i < CRON_SEARCH_MINUTES; i++) {
    if (matches(c, cursor)) return cursor;
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }

  throw new Error('cron expression matches no time in the next 90 days');
}

// ============================================================
// Tick
// ============================================================

async function fireSchedules(admin: any) {
  const nowIso = new Date().toISOString();

  const { data: due, error } = await admin.database
    .from('agent_schedules')
    .select('id, agent_id, channel_id, product_id, name, cron, min_interval_minutes, enabled')
    .eq('enabled', true)
    .lte('next_run_at', nowIso)
    .order('next_run_at', { ascending: true })
    .limit(MAX_SCHEDULES_PER_TICK);

  if (error) return { fired: 0, errors: [`schedule lookup failed: ${error.message}`] };

  const errors: string[] = [];
  let fired = 0;

  for (const s of due ?? []) {
    // Advance the clock FIRST. If queueing the run then fails, the schedule has
    // still moved on — a broken job retries next slot rather than firing in a
    // tight loop for as long as it stays broken.
    let next: string;
    try {
      next = nextRun(s.cron, new Date(), s.min_interval_minutes).toISOString();
    } catch (e) {
      await admin.database
        .from('agent_schedules')
        .update({ enabled: false, last_error: (e as Error).message.slice(0, 500) })
        .eq('id', s.id);
      errors.push(`${s.name}: ${(e as Error).message} — schedule disabled`);
      continue;
    }

    await admin.database
      .from('agent_schedules')
      .update({ last_run_at: new Date().toISOString(), next_run_at: next, last_error: null })
      .eq('id', s.id);

    const { data: agents } = await admin.database
      .from('agents')
      .select('user_id, model, enabled')
      .eq('user_id', s.agent_id)
      .limit(1);

    const agent = agents?.[0];
    if (!agent?.enabled) {
      errors.push(`${s.name}: agent is disabled`);
      continue;
    }

    const { error: insertError } = await admin.database.from('agent_runs').insert([
      {
        agent_id: s.agent_id,
        schedule_id: s.id,
        channel_id: s.channel_id,
        model: agent.model,
        status: 'pending',
      },
    ]);

    if (insertError) {
      errors.push(`${s.name}: could not queue run — ${insertError.message}`);
      continue;
    }

    fired += 1;
  }

  return { fired, errors };
}

// The drain is delegated to thread-agent rather than duplicated: one copy of the
// OpenRouter call, one copy of the budget check, one copy of the proposal rules.
async function drainRuns(baseUrl: string): Promise<unknown> {
  const secret = Deno.env.get('AGENT_TICK_SECRET');
  if (!secret) return { drained: 0, error: 'AGENT_TICK_SECRET is not set' };

  const res = await fetch(`${baseUrl}/functions/thread-agent`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${secret}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ action: 'drain', limit: MAX_DRAIN_PER_TICK }),
  });

  if (!res.ok) {
    return { drained: 0, error: `drain failed (${res.status}): ${(await res.text()).slice(0, 300)}` };
  }
  return await res.json();
}

// ============================================================
// Entry point
// ============================================================
// Authenticated by the schedule's bearer secret. There is no user behind a tick,
// so there is no JWT to resolve.

export default async function (req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const secret = Deno.env.get('AGENT_TICK_SECRET');
  const provided = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '').trim();
  if (!secret || provided !== secret) {
    return new Response(JSON.stringify({ error: { code: 'forbidden', message: 'Unauthorized' } }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  if (!PIPELINE_ENABLED) {
    return new Response(JSON.stringify({ skipped: 'pipeline disabled' }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const baseUrl = Deno.env.get('INSFORGE_BASE_URL')!;
  const admin = createAdminClient({ baseUrl, apiKey: Deno.env.get('API_KEY')! });

  const scheduled = await fireSchedules(admin);
  const drained = await drainRuns(baseUrl);

  return new Response(JSON.stringify({ scheduled, drained }), {
    status: 200,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}
