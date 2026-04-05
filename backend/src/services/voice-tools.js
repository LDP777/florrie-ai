/**
 * Voice Tool Library — every callable action Ellie (or any beautician) can
 * trigger via voice. Tools are defined as Claude tool-call specs AND implemented
 * as real async handlers here.
 *
 * Architecture:
 *   1. TOOL_DEFINITIONS  — Claude tool-use schema (what Claude can call)
 *   2. executeTools()    — dispatcher (routes tool calls to handlers below)
 *   3. Individual tool handlers (the real implementations)
 *
 * Adding a new capability:
 *   1. Add an entry to TOOL_DEFINITIONS with name, description, input_schema
 *   2. Add a case in executeTools()
 *   3. Implement the handler function
 */

import Stripe from 'stripe';
import { sendMessage } from './notifications.js';
import { calculatePlatformFee } from '../lib/platform-fees.js';
import logger from '../lib/logger.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

// ─── Tool definitions (sent to Claude) ──────────────────────────────────────

export const TOOL_DEFINITIONS = [

  // ── SCHEDULE ──────────────────────────────────────────────────────────────
  {
    name: 'check_schedule',
    description: 'Get all appointments for a specific date. Use for "what\'s my schedule today", "do I have anything on Thursday", etc.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD. Defaults to today.' },
      },
      required: [],
    },
  },
  {
    name: 'get_upcoming_appointments',
    description: 'Get all upcoming appointments in the next N days.',
    input_schema: {
      type: 'object',
      properties: {
        days_ahead: { type: 'number', description: 'How many days ahead to look (default 7).' },
      },
      required: [],
    },
  },

  // ── APPOINTMENTS ──────────────────────────────────────────────────────────
  {
    name: 'book_appointment',
    description: 'Create a new appointment for a client. Finds the client and treatment by name.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string', description: 'Client first name or full name.' },
        treatment: { type: 'string', description: 'Treatment name (partial match ok).' },
        date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        time: { type: 'string', description: '24h time HH:MM.' },
      },
      required: ['client_name', 'date', 'time'],
    },
  },
  {
    name: 'reschedule_appointment',
    description: 'Move a client\'s next upcoming appointment to a new date/time.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        new_date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        new_time: { type: 'string', description: '24h time HH:MM.' },
        notify_client: { type: 'boolean', description: 'Send SMS/WhatsApp confirmation (default true).' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel a client\'s next upcoming appointment.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        notify_client: { type: 'boolean', description: 'Send cancellation message (default true).' },
      },
      required: ['client_name'],
    },
  },

  // ── TIME BLOCKING ─────────────────────────────────────────────────────────
  {
    name: 'block_date',
    description: 'Block a single day or time slot. Use for "block Friday afternoon", "mark Tuesday as closed".',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        all_day: { type: 'boolean', description: 'Block the entire day (default true unless start_time given).' },
        start_time: { type: 'string', description: '24h time HH:MM. If set, blocks from this time.' },
        end_time: { type: 'string', description: '24h time HH:MM. If set, blocks until this time.' },
        reason: { type: 'string', description: 'holiday | sick | personal | training | event | other' },
        note: { type: 'string' },
      },
      required: ['date'],
    },
  },
  {
    name: 'block_date_range',
    description: 'Block multiple consecutive days. Perfect for holidays, half-term, time off. Creates one hours_exception per day.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string', description: 'ISO date YYYY-MM-DD — first day of the block.' },
        to_date: { type: 'string', description: 'ISO date YYYY-MM-DD — last day of the block (inclusive).' },
        reason: { type: 'string', description: 'holiday | sick | personal | training | event | other' },
        note: { type: 'string', description: 'Optional note shown in calendar.' },
        skip_weekends: { type: 'boolean', description: 'Skip Saturdays and Sundays (default false).' },
      },
      required: ['from_date', 'to_date'],
    },
  },
  {
    name: 'clear_block',
    description: 'Remove a time block / exception for a specific date.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
      },
      required: ['date'],
    },
  },

  // ── CLIENTS ───────────────────────────────────────────────────────────────
  {
    name: 'get_client_info',
    description: 'Look up a client\'s visit history, total spend, last visit, and next appointment.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_lapsed_clients',
    description: 'Get clients who haven\'t visited in the last N days. Useful for "who haven\'t I seen in a while".',
    input_schema: {
      type: 'object',
      properties: {
        days_since_last_visit: { type: 'number', description: 'Minimum days since last visit (default 60).' },
        limit: { type: 'number', description: 'Max clients to return (default 10).' },
      },
      required: [],
    },
  },
  {
    name: 'add_client_note',
    description: 'Add a note to a client\'s record.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        note: { type: 'string' },
      },
      required: ['client_name', 'note'],
    },
  },

  // ── MESSAGING ─────────────────────────────────────────────────────────────
  {
    name: 'send_message',
    description: 'Send an SMS/WhatsApp/email message to a single client.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        message: { type: 'string', description: 'The message text to send.' },
      },
      required: ['client_name', 'message'],
    },
  },
  {
    name: 'send_bulk_message',
    description: 'Send a message to multiple clients at once. Use for "message everyone booked this week", "text all lapsed clients".',
    input_schema: {
      type: 'object',
      properties: {
        segment: {
          type: 'string',
          description: 'Who to send to: "booked_this_week" | "booked_next_week" | "booked_in_range" | "lapsed_60" | "lapsed_90" | "all_active"',
        },
        date_from: { type: 'string', description: 'ISO date — used with booked_in_range.' },
        date_to: { type: 'string', description: 'ISO date — used with booked_in_range.' },
        message_template: { type: 'string', description: 'Message text. Use {first_name} for personalisation.' },
      },
      required: ['segment', 'message_template'],
    },
  },
  {
    name: 'send_payment_link',
    description: 'Generate a Stripe payment link and send it to a client.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        amount_pence: { type: 'number', description: 'Amount in pence (e.g. 3000 = £30).' },
        description: { type: 'string', description: 'What the payment is for.' },
      },
      required: ['client_name', 'amount_pence'],
    },
  },
  {
    name: 'send_rebook_reminder',
    description: 'Send a personalised rebook reminder to a client.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        treatment: { type: 'string', description: 'Treatment to reference in the reminder (optional).' },
      },
      required: ['client_name'],
    },
  },

  // ── MONEY ─────────────────────────────────────────────────────────────────
  {
    name: 'get_revenue_summary',
    description: 'Get revenue stats for a period. Use for "how much did I make last month", "what\'s my revenue this week".',
    input_schema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: '"today" | "this_week" | "last_week" | "this_month" | "last_month" | "this_year" — or provide from_date/to_date.',
        },
        from_date: { type: 'string', description: 'ISO date, used with custom range.' },
        to_date: { type: 'string', description: 'ISO date, used with custom range.' },
      },
      required: [],
    },
  },
  {
    name: 'get_outstanding_payments',
    description: 'Get a list of clients with unpaid/outstanding balances.',
    input_schema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'create_expense',
    description: 'Log a business expense.',
    input_schema: {
      type: 'object',
      properties: {
        amount_pence: { type: 'number' },
        category: { type: 'string', description: 'e.g. supplies, software, rent, training, equipment' },
        description: { type: 'string' },
        date: { type: 'string', description: 'ISO date (defaults to today).' },
      },
      required: ['amount_pence', 'category', 'description'],
    },
  },

  // ── NOTES & CHECKLISTS ────────────────────────────────────────────────────
  {
    name: 'add_note',
    description: 'Add an item to today\'s daily checklist / notes.',
    input_schema: {
      type: 'object',
      properties: {
        note: { type: 'string' },
      },
      required: ['note'],
    },
  },

  // ── REPORTS ───────────────────────────────────────────────────────────────
  {
    name: 'get_top_clients',
    description: 'Get the top N clients by total spend.',
    input_schema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Number of clients (default 5).' },
      },
      required: [],
    },
  },
  {
    name: 'get_busiest_days',
    description: 'Find out which days of the week are busiest based on historical bookings.',
    input_schema: {
      type: 'object',
      properties: {
        weeks_back: { type: 'number', description: 'How many weeks of history to analyse (default 8).' },
      },
      required: [],
    },
  },
  {
    name: 'get_revenue_by_treatment',
    description: 'Breakdown of revenue by treatment type.',
    input_schema: {
      type: 'object',
      properties: {
        from_date: { type: 'string' },
        to_date: { type: 'string' },
      },
      required: [],
    },
  },
];

// ─── Tool executor ───────────────────────────────────────────────────────────

/**
 * Execute a single tool call.
 * @param {string} toolName
 * @param {object} toolInput — the extracted args from Claude
 * @param {object} beautician — the authenticated beautician record
 * @param {object} supabase — the supabase client
 * @returns {{ result: string, data?: object }} human-readable result + optional structured data
 */
export async function executeTool(toolName, toolInput, beautician, supabase) {
  try {
    switch (toolName) {
      case 'check_schedule':        return await toolCheckSchedule(toolInput, beautician, supabase);
      case 'get_upcoming_appointments': return await toolGetUpcoming(toolInput, beautician, supabase);
      case 'book_appointment':      return await toolBookAppointment(toolInput, beautician, supabase);
      case 'reschedule_appointment': return await toolReschedule(toolInput, beautician, supabase);
      case 'cancel_appointment':    return await toolCancelAppointment(toolInput, beautician, supabase);
      case 'block_date':            return await toolBlockDate(toolInput, beautician, supabase);
      case 'block_date_range':      return await toolBlockDateRange(toolInput, beautician, supabase);
      case 'clear_block':           return await toolClearBlock(toolInput, beautician, supabase);
      case 'get_client_info':       return await toolGetClientInfo(toolInput, beautician, supabase);
      case 'get_lapsed_clients':    return await toolGetLapsedClients(toolInput, beautician, supabase);
      case 'add_client_note':       return await toolAddClientNote(toolInput, beautician, supabase);
      case 'send_message':          return await toolSendMessage(toolInput, beautician, supabase);
      case 'send_bulk_message':     return await toolSendBulkMessage(toolInput, beautician, supabase);
      case 'send_payment_link':     return await toolSendPaymentLink(toolInput, beautician, supabase);
      case 'send_rebook_reminder':  return await toolSendRebookReminder(toolInput, beautician, supabase);
      case 'get_revenue_summary':   return await toolGetRevenueSummary(toolInput, beautician, supabase);
      case 'get_outstanding_payments': return await toolGetOutstandingPayments(toolInput, beautician, supabase);
      case 'create_expense':        return await toolCreateExpense(toolInput, beautician, supabase);
      case 'add_note':              return await toolAddNote(toolInput, beautician, supabase);
      case 'get_top_clients':       return await toolGetTopClients(toolInput, beautician, supabase);
      case 'get_busiest_days':      return await toolGetBusiestDays(toolInput, beautician, supabase);
      case 'get_revenue_by_treatment': return await toolGetRevenueByTreatment(toolInput, beautician, supabase);
      default:
        return { result: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error({ err, toolName }, 'Tool execution failed');
    return { result: `Something went wrong running ${toolName}.` };
  }
}

// ─── Schedule tools ──────────────────────────────────────────────────────────

async function toolCheckSchedule({ date }, beautician, supabase) {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at, clients(first_name), treatments(name), status')
    .eq('beautician_id', beautician.id)
    .gte('starts_at', `${targetDate}T00:00:00`)
    .lte('starts_at', `${targetDate}T23:59:59`)
    .in('status', ['confirmed', 'pending'])
    .order('starts_at', { ascending: true });

  if (!appts?.length) {
    const dayName = new Date(`${targetDate}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
    return { result: `Nothing booked for ${dayName}.`, data: { appointments: [], date: targetDate } };
  }

  const lines = appts.map(a => {
    const t = new Date(a.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${t} — ${a.clients?.first_name || 'Client'} (${a.treatments?.name || 'Treatment'})`;
  });

  const dayName = new Date(`${targetDate}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return {
    result: `${dayName}: ${appts.length} appointment${appts.length !== 1 ? 's' : ''}.\n${lines.join('\n')}`,
    data: { appointments: appts, date: targetDate, count: appts.length },
  };
}

async function toolGetUpcoming({ days_ahead = 7 }, beautician, supabase) {
  const from = new Date().toISOString();
  const to = new Date(Date.now() + days_ahead * 86400000).toISOString();

  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at, clients(first_name), treatments(name), status')
    .eq('beautician_id', beautician.id)
    .gte('starts_at', from)
    .lte('starts_at', to)
    .in('status', ['confirmed', 'pending'])
    .order('starts_at', { ascending: true });

  if (!appts?.length) {
    return { result: `Nothing booked in the next ${days_ahead} days.`, data: { appointments: [] } };
  }

  const lines = appts.map(a => {
    const d = new Date(a.starts_at);
    const dayStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
    return `${dayStr} ${timeStr} — ${a.clients?.first_name || 'Client'} (${a.treatments?.name || 'Treatment'})`;
  });

  return {
    result: `${appts.length} appointment${appts.length !== 1 ? 's' : ''} in the next ${days_ahead} days:\n${lines.join('\n')}`,
    data: { appointments: appts },
  };
}

// ─── Appointment tools ───────────────────────────────────────────────────────

async function toolBookAppointment({ client_name, treatment, date, time }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find a client called "${client_name}".` };

  let treatmentId = null;
  let treatmentName = treatment || 'Appointment';
  let durationMins = 60;
  let priceCents = 0;

  if (treatment) {
    const { data: treats } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents')
      .eq('beautician_id', beautician.id)
      .ilike('name', `%${treatment}%`)
      .limit(1);

    if (treats?.[0]) {
      treatmentId = treats[0].id;
      treatmentName = treats[0].name;
      durationMins = treats[0].duration_minutes || 60;
      priceCents = treats[0].price_cents || 0;
    }
  }

  const startsAt = new Date(`${date}T${time}:00`);
  const endsAt = new Date(startsAt.getTime() + durationMins * 60000);

  const { data: newAppt, error } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id: treatmentId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      status: 'confirmed',
      price_cents: priceCents,
      source: 'voice_command',
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ err: error }, 'Voice book appointment insert failed');
    return { result: 'Something went wrong creating the booking.' };
  }

  const friendlyDate = startsAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const friendlyTime = startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  await sendMessage({
    client,
    body: `Hi ${client.first_name}! Your ${treatmentName} is confirmed for ${friendlyDate} at ${friendlyTime}. Can't wait to see you 💕`,
    beauticianId: beautician.id,
    beauticianPrefs: beautician.client_reminder_prefs || {},
  }).catch(e => logger.warn({ err: e }, 'Booking confirmation send failed'));

  return {
    result: `Booked ${client.first_name} in for ${treatmentName} on ${friendlyDate} at ${friendlyTime}. Confirmation sent.`,
    data: { appointmentId: newAppt?.id },
  };
}

async function toolReschedule({ client_name, new_date, new_time, notify_client = true }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find a client called "${client_name}".` };

  const { data: appts } = await supabase
    .from('appointments')
    .select('id, starts_at, duration_minutes, treatments(name)')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .in('status', ['confirmed', 'pending'])
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(1);

  const appt = appts?.[0];
  if (!appt) return { result: `${client.first_name} has no upcoming appointments to reschedule.` };

  const existing = new Date(appt.starts_at);
  const resolvedDate = new_date || existing.toISOString().slice(0, 10);
  const resolvedTime = new_time || existing.toTimeString().slice(0, 5);
  const newStart = new Date(`${resolvedDate}T${resolvedTime}:00`);

  if (isNaN(newStart.getTime())) {
    return { result: "Couldn't parse that date/time. Try something like 'Thursday at 2pm'." };
  }

  const newEnd = new Date(newStart.getTime() + (appt.duration_minutes || 60) * 60000);

  await supabase
    .from('appointments')
    .update({ starts_at: newStart.toISOString(), ends_at: newEnd.toISOString() })
    .eq('id', appt.id);

  const treatmentName = appt.treatments?.name || 'appointment';
  const friendlyDate = newStart.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const friendlyTime = newStart.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });

  if (notify_client) {
    await sendMessage({
      client,
      body: `Hi ${client.first_name}! Quick update — your ${treatmentName} has been moved to ${friendlyDate} at ${friendlyTime}. See you then! 💕`,
      beauticianId: beautician.id,
      beauticianPrefs: beautician.client_reminder_prefs || {},
    }).catch(e => logger.warn({ err: e }, 'Reschedule notification failed'));
  }

  return {
    result: `Moved ${client.first_name}'s ${treatmentName} to ${friendlyDate} at ${friendlyTime}${notify_client ? '. Confirmation sent.' : '.'}`,
    data: { appointmentId: appt.id },
  };
}

async function toolCancelAppointment({ client_name, notify_client = true }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const { data: appts } = await supabase
    .from('appointments')
    .select('id, starts_at, treatments(name)')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .in('status', ['confirmed', 'pending'])
    .gte('starts_at', new Date().toISOString())
    .order('starts_at', { ascending: true })
    .limit(1);

  const appt = appts?.[0];
  if (!appt) return { result: `${client.first_name} has no upcoming appointments to cancel.` };

  await supabase.from('appointments').update({ status: 'cancelled' }).eq('id', appt.id);

  const treatmentName = appt.treatments?.name || 'appointment';
  const friendlyDate = new Date(appt.starts_at).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });

  if (notify_client) {
    await sendMessage({
      client,
      body: `Hi ${client.first_name}, your ${treatmentName} on ${friendlyDate} has been cancelled. Get in touch if you'd like to rebook 💕`,
      beauticianId: beautician.id,
      beauticianPrefs: beautician.client_reminder_prefs || {},
    }).catch(e => logger.warn({ err: e }, 'Cancel notification failed'));
  }

  return {
    result: `${client.first_name}'s ${treatmentName} on ${friendlyDate} cancelled${notify_client ? ' — they\'ve been notified.' : '.'}`,
  };
}

// ─── Time blocking tools ─────────────────────────────────────────────────────

async function toolBlockDate({ date, all_day, start_time, end_time, reason = 'personal', note }, beautician, supabase) {
  const isAllDay = all_day !== false && !start_time;

  const row = {
    beautician_id: beautician.id,
    date,
    type: isAllDay ? 'closed' : 'amended',
    reason,
    note: note || null,
    notify_clients: false,
  };

  if (!isAllDay && start_time) {
    row.start_time = start_time;
    row.end_time = end_time || '18:00';
  }

  const { error } = await supabase.from('hours_exceptions').insert(row);
  if (error) {
    logger.error({ err: error }, 'block_date insert failed');
    return { result: 'Could not block that date — something went wrong.' };
  }

  const friendlyDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const timeStr = !isAllDay && start_time ? ` from ${start_time}${end_time ? ` to ${end_time}` : ''}` : '';

  return { result: `Blocked ${friendlyDate}${timeStr} (${reason}).` };
}

async function toolBlockDateRange({ from_date, to_date, reason = 'holiday', note, skip_weekends = false }, beautician, supabase) {
  const days = [];
  let cur = new Date(`${from_date}T12:00:00`);
  const end = new Date(`${to_date}T12:00:00`);

  while (cur <= end) {
    const dayOfWeek = cur.getDay();
    if (!skip_weekends || (dayOfWeek !== 0 && dayOfWeek !== 6)) {
      days.push(cur.toISOString().slice(0, 10));
    }
    cur.setDate(cur.getDate() + 1);
  }

  if (!days.length) {
    return { result: 'No days to block in that range (all weekends, skipped).' };
  }

  const rows = days.map(d => ({
    beautician_id: beautician.id,
    date: d,
    type: 'closed',
    reason,
    note: note || null,
    notify_clients: false,
  }));

  // Upsert to avoid duplicates if some days already blocked
  const { error } = await supabase
    .from('hours_exceptions')
    .upsert(rows, { onConflict: 'beautician_id,date', ignoreDuplicates: false });

  if (error) {
    logger.error({ err: error }, 'block_date_range insert failed');
    return { result: 'Something went wrong blocking those dates.' };
  }

  const fromFriendly = new Date(`${from_date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  const toFriendly = new Date(`${to_date}T12:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' });

  return {
    result: `Blocked ${days.length} day${days.length !== 1 ? 's' : ''} from ${fromFriendly} to ${toFriendly} (${reason}).`,
    data: { blocked_dates: days, count: days.length },
  };
}

async function toolClearBlock({ date }, beautician, supabase) {
  const { error } = await supabase
    .from('hours_exceptions')
    .delete()
    .eq('beautician_id', beautician.id)
    .eq('date', date);

  if (error) {
    logger.error({ err: error }, 'clear_block failed');
    return { result: 'Could not clear that block.' };
  }

  const friendlyDate = new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' });
  return { result: `Block removed for ${friendlyDate}.` };
}

// ─── Client tools ────────────────────────────────────────────────────────────

async function toolGetClientInfo({ client_name }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at, price_cents, status, treatments(name)')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    .order('starts_at', { ascending: false })
    .limit(20);

  const completed = (appts || []).filter(a => a.status === 'completed');
  const totalSpend = completed.reduce((s, a) => s + (a.price_cents || 0), 0);
  const lastVisit = completed[0]?.starts_at;
  const upcoming = (appts || []).find(a => ['confirmed', 'pending'].includes(a.status));

  const lastStr = lastVisit
    ? new Date(lastVisit).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
    : 'no visits yet';
  const upcomingStr = upcoming
    ? `${new Date(upcoming.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} (${upcoming.treatments?.name || 'appointment'})`
    : 'none booked';

  return {
    result: `${client.first_name} ${client.last_name || ''}: ${completed.length} visits · £${(totalSpend / 100).toFixed(2)} spend · Last: ${lastStr} · Next: ${upcomingStr}`,
    data: { client, visitCount: completed.length, totalSpend, lastVisit, upcoming },
  };
}

async function toolGetLapsedClients({ days_since_last_visit = 60, limit = 10 }, beautician, supabase) {
  const cutoff = new Date(Date.now() - days_since_last_visit * 86400000).toISOString();

  // Get client IDs with a completed appointment after the cutoff (not lapsed)
  const { data: recentAppts } = await supabase
    .from('appointments')
    .select('client_id')
    .eq('beautician_id', beautician.id)
    .eq('status', 'completed')
    .gte('starts_at', cutoff);

  const recentClientIds = new Set((recentAppts || []).map(a => a.client_id));

  // Get all clients
  const { data: clients } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beautician.id)
    .eq('is_active', true)
    .limit(200);

  const lapsed = (clients || []).filter(c => !recentClientIds.has(c.id)).slice(0, limit);

  if (!lapsed.length) {
    return { result: `Everyone's been in recently — no lapsed clients found in the last ${days_since_last_visit} days.` };
  }

  const names = lapsed.map(c => `${c.first_name} ${c.last_name || ''}`.trim()).join(', ');
  return {
    result: `${lapsed.length} client${lapsed.length !== 1 ? 's' : ''} haven't visited in ${days_since_last_visit}+ days: ${names}`,
    data: { clients: lapsed },
  };
}

async function toolAddClientNote({ client_name, note }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const { error } = await supabase
    .from('client_notes')
    .insert({ beautician_id: beautician.id, client_id: client.id, note, created_at: new Date().toISOString() });

  if (error) {
    logger.error({ err: error }, 'add_client_note failed');
    return { result: 'Could not save the note — something went wrong.' };
  }

  return { result: `Note added to ${client.first_name}'s record.` };
}

// ─── Messaging tools ─────────────────────────────────────────────────────────

async function toolSendMessage({ client_name, message }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  await sendMessage({
    client,
    body: message,
    beauticianId: beautician.id,
    beauticianPrefs: beautician.client_reminder_prefs || {},
  });

  return { result: `Message sent to ${client.first_name}.` };
}

async function toolSendBulkMessage({ segment, date_from, date_to, message_template }, beautician, supabase) {
  let clients = [];

  if (segment === 'booked_this_week' || segment === 'booked_next_week' || segment === 'booked_in_range') {
    let from, to;
    const now = new Date();

    if (segment === 'booked_this_week') {
      const startOfWeek = new Date(now);
      startOfWeek.setDate(now.getDate() - now.getDay() + 1);
      from = startOfWeek.toISOString().slice(0, 10);
      const endOfWeek = new Date(startOfWeek);
      endOfWeek.setDate(startOfWeek.getDate() + 6);
      to = endOfWeek.toISOString().slice(0, 10);
    } else if (segment === 'booked_next_week') {
      const startOfNextWeek = new Date(now);
      startOfNextWeek.setDate(now.getDate() - now.getDay() + 8);
      from = startOfNextWeek.toISOString().slice(0, 10);
      const endOfNextWeek = new Date(startOfNextWeek);
      endOfNextWeek.setDate(startOfNextWeek.getDate() + 6);
      to = endOfNextWeek.toISOString().slice(0, 10);
    } else {
      from = date_from;
      to = date_to;
    }

    const { data: appts } = await supabase
      .from('appointments')
      .select('clients(id, first_name, last_name, phone, email)')
      .eq('beautician_id', beautician.id)
      .gte('starts_at', `${from}T00:00:00`)
      .lte('starts_at', `${to}T23:59:59`)
      .in('status', ['confirmed', 'pending']);

    clients = [...new Map((appts || [])
      .map(a => a.clients)
      .filter(Boolean)
      .map(c => [c.id, c]))
      .values()];

  } else if (segment === 'lapsed_60' || segment === 'lapsed_90') {
    const days = segment === 'lapsed_60' ? 60 : 90;
    const lapsedResult = await toolGetLapsedClients({ days_since_last_visit: days, limit: 100 }, beautician, supabase);
    clients = lapsedResult.data?.clients || [];

  } else if (segment === 'all_active') {
    const { data } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone, email')
      .eq('beautician_id', beautician.id)
      .eq('is_active', true)
      .limit(500);
    clients = data || [];
  }

  if (!clients.length) {
    return { result: `No clients found for segment "${segment}".` };
  }

  let sent = 0;
  let failed = 0;

  for (const client of clients) {
    const body = message_template.replace(/\{first_name\}/gi, client.first_name || 'there');
    try {
      await sendMessage({
        client,
        body,
        beauticianId: beautician.id,
        beauticianPrefs: beautician.client_reminder_prefs || {},
      });
      sent++;
    } catch (e) {
      logger.warn({ err: e, clientId: client.id }, 'Bulk message send failed for client');
      failed++;
    }
  }

  return {
    result: `Sent to ${sent} client${sent !== 1 ? 's' : ''}${failed > 0 ? ` (${failed} failed)` : ''}.`,
    data: { sent, failed, total: clients.length },
  };
}

async function toolSendPaymentLink({ client_name, amount_pence, description }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const desc = description || `Payment to ${beautician.business_name || beautician.first_name}`;

  if (!stripe || !beautician.stripe_account_id || !beautician.stripe_onboarding_complete) {
    return { result: `Stripe isn't connected yet — head to Settings → Payments to connect it.` };
  }

  const platformFee = calculatePlatformFee(amount_pence);
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    line_items: [{
      price_data: { currency: 'gbp', product_data: { name: desc }, unit_amount: amount_pence },
      quantity: 1,
    }],
    payment_intent_data: {
      application_fee_amount: platformFee,
      transfer_data: { destination: beautician.stripe_account_id },
      metadata: { beautician_id: beautician.id, client_id: client.id, type: 'voice_payment_link' },
    },
    success_url: `${FRONTEND_URL}/pay/success`,
    cancel_url: `${FRONTEND_URL}/pay/cancelled`,
    metadata: { beautician_id: beautician.id, client_id: client.id },
  });

  await supabase.from('payment_links').insert({
    beautician_id: beautician.id,
    client_id: client.id,
    amount_cents: amount_pence,
    description: desc,
    stripe_session_id: session.id,
    url: session.url,
    status: 'pending',
  }).catch(() => {});

  const amountStr = `£${(amount_pence / 100).toFixed(2)}`;

  await sendMessage({
    client,
    body: `Hi ${client.first_name}! Here's your payment link for ${amountStr}:\n${session.url}\n\nThanks! 💕`,
    beauticianId: beautician.id,
    beauticianPrefs: beautician.client_reminder_prefs || {},
  });

  return {
    result: `Payment link for ${amountStr} sent to ${client.first_name}.`,
    data: { paymentUrl: session.url },
  };
}

async function toolSendRebookReminder({ client_name, treatment }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const treatmentRef = treatment ? `your ${treatment}` : 'your next appointment';
  const bizName = beautician.business_name || beautician.first_name;

  await sendMessage({
    client,
    body: `Hi ${client.first_name}! It's been a while — time to book ${treatmentRef}? 💕 Reply or book online at ${FRONTEND_URL}/book/${beautician.booking_slug || ''}`,
    beauticianId: beautician.id,
    beauticianPrefs: beautician.client_reminder_prefs || {},
  });

  return { result: `Rebook reminder sent to ${client.first_name}.` };
}

// ─── Money tools ─────────────────────────────────────────────────────────────

async function toolGetRevenueSummary({ period = 'this_month', from_date, to_date }, beautician, supabase) {
  const now = new Date();
  let from, to;

  switch (period) {
    case 'today':
      from = now.toISOString().slice(0, 10);
      to = from;
      break;
    case 'this_week': {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay() + 1);
      from = d.toISOString().slice(0, 10);
      const e = new Date(d); e.setDate(d.getDate() + 6);
      to = e.toISOString().slice(0, 10);
      break;
    }
    case 'last_week': {
      const d = new Date(now);
      d.setDate(d.getDate() - d.getDay() - 6);
      from = d.toISOString().slice(0, 10);
      const e = new Date(d); e.setDate(d.getDate() + 6);
      to = e.toISOString().slice(0, 10);
      break;
    }
    case 'this_month':
      from = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
      to = now.toISOString().slice(0, 10);
      break;
    case 'last_month': {
      const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      from = d.toISOString().slice(0, 10);
      const e = new Date(now.getFullYear(), now.getMonth(), 0);
      to = e.toISOString().slice(0, 10);
      break;
    }
    case 'this_year':
      from = `${now.getFullYear()}-01-01`;
      to = now.toISOString().slice(0, 10);
      break;
    default:
      from = from_date || now.toISOString().slice(0, 10);
      to = to_date || from;
  }

  const { data: appts } = await supabase
    .from('appointments')
    .select('price_cents, status')
    .eq('beautician_id', beautician.id)
    .eq('status', 'completed')
    .gte('starts_at', `${from}T00:00:00`)
    .lte('starts_at', `${to}T23:59:59`);

  const total = (appts || []).reduce((s, a) => s + (a.price_cents || 0), 0);
  const count = appts?.length || 0;
  const avg = count > 0 ? total / count : 0;

  const periodLabel = period.replace('_', ' ');
  return {
    result: `Revenue ${periodLabel}: £${(total / 100).toFixed(2)} from ${count} appointment${count !== 1 ? 's' : ''} (avg £${(avg / 100).toFixed(2)}).`,
    data: { total_pence: total, count, avg_pence: avg, from, to },
  };
}

async function toolGetOutstandingPayments({ }, beautician, supabase) {
  const { data: links } = await supabase
    .from('payment_links')
    .select('amount_cents, description, status, created_at, clients(first_name, last_name)')
    .eq('beautician_id', beautician.id)
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(20);

  if (!links?.length) return { result: 'No outstanding payment links.' };

  const total = links.reduce((s, l) => s + (l.amount_cents || 0), 0);
  const lines = links.map(l =>
    `${l.clients?.first_name || 'Client'} — £${(l.amount_cents / 100).toFixed(2)} (${l.description || 'payment'})`
  );

  return {
    result: `${links.length} outstanding payment${links.length !== 1 ? 's' : ''} totalling £${(total / 100).toFixed(2)}:\n${lines.join('\n')}`,
    data: { links },
  };
}

async function toolCreateExpense({ amount_pence, category, description, date }, beautician, supabase) {
  const expenseDate = date || new Date().toISOString().slice(0, 10);
  const { error } = await supabase.from('expenses').insert({
    beautician_id: beautician.id,
    amount_cents: amount_pence,
    category,
    description,
    date: expenseDate,
    source: 'voice_command',
  });

  if (error) {
    logger.error({ err: error }, 'create_expense failed');
    return { result: 'Could not log the expense — something went wrong.' };
  }

  return { result: `Logged £${(amount_pence / 100).toFixed(2)} expense: ${description} (${category}).` };
}

// ─── Notes tool ──────────────────────────────────────────────────────────────

async function toolAddNote({ note }, beautician, supabase) {
  const today = new Date().toISOString().slice(0, 10);
  await supabase.from('daily_checklists').insert({
    beautician_id: beautician.id,
    date: today,
    items: [{ text: note, done: false }],
    done: false,
  });
  return { result: `Added to today's checklist: "${note}"` };
}

// ─── Reports tools ───────────────────────────────────────────────────────────

async function toolGetTopClients({ limit = 5 }, beautician, supabase) {
  const { data: appts } = await supabase
    .from('appointments')
    .select('client_id, price_cents, clients(first_name, last_name)')
    .eq('beautician_id', beautician.id)
    .eq('status', 'completed');

  const totals = {};
  for (const a of (appts || [])) {
    if (!a.client_id) continue;
    totals[a.client_id] = totals[a.client_id] || { name: `${a.clients?.first_name || ''} ${a.clients?.last_name || ''}`.trim(), total: 0 };
    totals[a.client_id].total += a.price_cents || 0;
  }

  const sorted = Object.values(totals).sort((a, b) => b.total - a.total).slice(0, limit);
  if (!sorted.length) return { result: 'No completed appointments yet.' };

  const lines = sorted.map((c, i) => `${i + 1}. ${c.name} — £${(c.total / 100).toFixed(2)}`);
  return { result: `Top ${sorted.length} clients:\n${lines.join('\n')}`, data: { clients: sorted } };
}

async function toolGetBusiestDays({ weeks_back = 8 }, beautician, supabase) {
  const from = new Date(Date.now() - weeks_back * 7 * 86400000).toISOString();

  const { data: appts } = await supabase
    .from('appointments')
    .select('starts_at')
    .eq('beautician_id', beautician.id)
    .eq('status', 'completed')
    .gte('starts_at', from);

  const dayCounts = [0, 0, 0, 0, 0, 0, 0]; // Sun=0
  for (const a of (appts || [])) {
    dayCounts[new Date(a.starts_at).getDay()]++;
  }

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const ranked = dayCounts
    .map((count, i) => ({ day: dayNames[i], count }))
    .sort((a, b) => b.count - a.count)
    .filter(d => d.count > 0);

  if (!ranked.length) return { result: 'Not enough data yet.' };

  const lines = ranked.map(d => `${d.day}: ${d.count} booking${d.count !== 1 ? 's' : ''}`);
  return { result: `Busiest days (last ${weeks_back} weeks):\n${lines.join('\n')}` };
}

async function toolGetRevenueByTreatment({ from_date, to_date }, beautician, supabase) {
  const from = from_date || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const to = to_date || new Date().toISOString().slice(0, 10);

  const { data: appts } = await supabase
    .from('appointments')
    .select('price_cents, treatments(name)')
    .eq('beautician_id', beautician.id)
    .eq('status', 'completed')
    .gte('starts_at', `${from}T00:00:00`)
    .lte('starts_at', `${to}T23:59:59`);

  const totals = {};
  for (const a of (appts || [])) {
    const name = a.treatments?.name || 'Other';
    totals[name] = (totals[name] || 0) + (a.price_cents || 0);
  }

  const sorted = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  if (!sorted.length) return { result: 'No revenue data for that period.' };

  const lines = sorted.map(([name, total]) => `${name}: £${(total / 100).toFixed(2)}`);
  return { result: `Revenue by treatment:\n${lines.join('\n')}`, data: { totals } };
}

// ─── Shared helpers ──────────────────────────────────────────────────────────

export async function findClient(beauticianId, name, supabase) {
  if (!name) return null;

  // Try first name match first
  const { data } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beauticianId)
    .ilike('first_name', `%${name}%`)
    .limit(1);

  if (data?.[0]) return data[0];

  // Fall back to last name
  const { data: byLast } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beauticianId)
    .ilike('last_name', `%${name}%`)
    .limit(1);

  return byLast?.[0] || null;
}
