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
import { sendConsultationFormSMS } from '../routes/consultation-forms.js';
import {
  consultationStatusForClient,
  consultationsOutstanding,
  patchTestStatusForClient,
  patchTestsOutstanding,
  resolveSendableForm,
} from './voice-consultation.js';
import { totalApplicationFee } from '../lib/platform-fees.js';
import logger from '../lib/logger.js';
import { SETTINGS, byId, readSetting, coerceValue, describeValue, renderCatalogue, buildUpdate } from '../lib/app-settings.js';

const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://florrie.ai';

export const TOOL_DEFINITIONS = [

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
    description: 'Move a client appointment to a new date/time. ALWAYS pass appointment_date when the beautician names which appointment (e.g. "her appointment on the 15th").',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        appointment_date: { type: 'string', description: 'ISO date YYYY-MM-DD of the appointment being moved. Pass it whenever the beautician says which day.' },
        new_date: { type: 'string', description: 'ISO date YYYY-MM-DD.' },
        new_time: { type: 'string', description: '24h time HH:MM.' },
        notify_client: { type: 'boolean', description: 'Send SMS/WhatsApp confirmation (default true).' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'cancel_appointment',
    description: 'Cancel a client appointment. ALWAYS pass appointment_date when the beautician names which appointment.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        appointment_date: { type: 'string', description: 'ISO date YYYY-MM-DD of the appointment being cancelled. Pass it whenever the beautician says which day.' },
        notify_client: { type: 'boolean', description: 'Send cancellation message (default true).' },
      },
      required: ['client_name'],
    },
  },

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

  {
    name: 'check_consultation_form',
    description: "Whether a named client has a consultation form on file, when she filled it in, and how many answers are worth knowing before she sits down. Use for \"has Megan done her consultation form\", \"when did Sarah fill hers in\", \"is there anything I should know about Megan before she comes in\". Reports STATUS ONLY. The answers themselves appear on screen and are never spoken, because she is usually holding a client when she asks.",
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_consultations_needed',
    description: 'Who is booked in a date range whose treatment needs a consultation form and has nothing on file yet. Use for "does anyone tomorrow still need a consultation form", "who needs to fill one in this week", "is everyone booked in sorted for forms". Defaults to today plus the next seven days.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to seven days after the start.' },
      },
      required: [],
    },
  },
  {
    name: 'check_patch_test',
    description: 'Whether a named client still owes a patch test. Use for "does Megan need a patch test", "is Sarah patch tested", "has Megan had hers done". There is no pass or fail recorded anywhere, so this answers outstanding or done and never claims someone passed.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
      },
      required: ['client_name'],
    },
  },
  {
    name: 'get_patch_tests_needed',
    description: 'Everyone booked in a date range who still owes a patch test. Use for "who needs a patch test this week", "is anyone in tomorrow not patch tested". Defaults to today plus the next seven days.',
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to today.' },
        end_date: { type: 'string', description: 'YYYY-MM-DD. Defaults to seven days after the start.' },
      },
      required: [],
    },
  },
  {
    name: 'send_consultation_form',
    description: 'Text a client the link to fill in her consultation form. Use for "send Megan a consultation form", "get Sarah to fill her form in".',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
      },
      required: ['client_name'],
    },
  },
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
  {
    name: 'get_settings',
    description: 'Read back how Florrie is set up right now — whether she answers clients herself, whether confirmations go out, which channel she uses, and so on. Read-only, answers instantly. Use this when she asks what something is set to, or before changing anything so you can tell her what it is changing FROM.',
    input_schema: {
      type: 'object',
      properties: {
        setting_id: { type: 'string', description: 'One setting id to read. Omit to get all of them.' },
      },
      required: [],
    },
  },
  {
    name: 'change_setting',
    description: `Change how the app behaves for her. She can say things in her own words and you match them to a setting.

Settings:
${renderCatalogue()}

Match on meaning, not wording. "stop answering my clients yourself" is florrie_answers_easy_ones off. "turn the ai up" is it on. If you genuinely cannot tell which she means, ask rather than guessing — this changes how her business talks to her clients.

Nothing happens on your say-so: this comes back as a card she confirms.`,
    input_schema: {
      type: 'object',
      properties: {
        setting_id: { type: 'string', description: 'The id from the list above.' },
        value: { description: 'The new value. true/false for on-off settings.' },
      },
      required: ['setting_id', 'value'],
    },
  },
];

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
      case 'get_settings':          return await toolGetSettings(toolInput, beautician);
      case 'change_setting':        return await toolChangeSetting(toolInput, beautician, supabase);
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
      case 'check_consultation_form': return await toolCheckConsultationForm(toolInput, beautician, supabase);
      case 'get_consultations_needed': return await toolConsultationsNeeded(toolInput, beautician, supabase);
      case 'check_patch_test':      return await toolCheckPatchTest(toolInput, beautician, supabase);
      case 'get_patch_tests_needed': return await toolPatchTestsNeeded(toolInput, beautician, supabase);
      case 'send_consultation_form': return await toolSendConsultationForm(toolInput, beautician, supabase);
      default:
        return { result: `Unknown tool: ${toolName}` };
    }
  } catch (err) {
    logger.error({ err, toolName }, 'Tool execution failed');
    return { result: `Something went wrong running ${toolName}.` };
  }
}

/**
 * Read back how she is set up, in her words.
 *
 * Deliberately answers with the LABEL and the plain-English meaning rather
 * than the column name. She is asking a question about her business, not
 * inspecting a row.
 */
async function toolGetSettings({ setting_id }, beautician) {
  const list = setting_id ? [byId(setting_id)].filter(Boolean) : SETTINGS;
  if (!list.length) return { result: `I do not have a setting called "${setting_id}".` };

  const lines = list.map(s => {
    const v = readSetting(s, beautician);
    const state = s.type === 'boolean' ? (v ? 'on' : 'off') : String(v);
    return `${s.label}: ${state}`;
  });
  return {
    result: lines.join('\n'),
    data: {
      settings: list.map(s => ({
        id: s.id, label: s.label, value: readSetting(s, beautician), means: s.means,
      })),
    },
  };
}

/**
 * Apply a setting change.
 *
 * This only runs AFTER she has confirmed the card — voice-orchestrator holds
 * change_setting in CONFIRM_REQUIRED, so speech alone never reaches here.
 * Transcription mishears, and "don't pause my messages" and "pause my
 * messages" are one dropped word apart.
 */
async function toolChangeSetting({ setting_id, value }, beautician, supabase) {
  const setting = byId(setting_id);
  if (!setting) {
    return { result: `I do not have a setting called "${setting_id}". Ask me what you can change and I'll list them.` };
  }

  const coerced = coerceValue(setting, value);
  if (!coerced.ok) return { result: coerced.why };

  const before = readSetting(setting, beautician);
  if (before === coerced.value) {
    return { result: `${setting.label} is already ${setting.type === 'boolean' ? (before ? 'on' : 'off') : before}. Nothing to change.` };
  }

  const patch = buildUpdate(setting, coerced.value, beautician);
  const { error } = await supabase
    .from('beauticians')
    .update(patch)
    .eq('id', beautician.id);

  if (error) {
    logger.error({ err: error, settingId: setting_id }, 'Voice setting change failed');
    return { result: `I could not save that just now. Try again in a moment.` };
  }

  // Keep the in-memory record honest for the rest of this turn, so a follow-up
  // question in the same breath reads the new value rather than the old one.
  Object.assign(beautician, patch);

  logger.info({ beauticianId: beautician.id, settingId: setting.id, from: before, to: coerced.value }, 'Setting changed by voice');
  return {
    result: describeValue(setting, coerced.value),
    data: { setting_id: setting.id, label: setting.label, from: before, to: coerced.value },
  };
}

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
    // timeZone UTC: starts_at is salon wall time stored in the UTC slot
    const t = new Date(a.starts_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
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
    // timeZone UTC: the UTC slot holds the salon wall clock
    const dayStr = d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    const timeStr = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
    return `${dayStr} ${timeStr} — ${a.clients?.first_name || 'Client'} (${a.treatments?.name || 'Treatment'})`;
  });

  return {
    result: `${appts.length} appointment${appts.length !== 1 ? 's' : ''} in the next ${days_ahead} days:\n${lines.join('\n')}`,
    data: { appointments: appts },
  };
}

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

  const startsAt = new Date(`${date}T${time}:00Z`); // wall time into the UTC slot, per the starts_at convention
  const endsAt = new Date(startsAt.getTime() + durationMins * 60000);

  const { data: newAppt, error } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id: treatmentId,
      starts_at: startsAt.toISOString(),
      ends_at: endsAt.toISOString(),
      duration_minutes: durationMins, // NOT NULL - its absence also killed every insert
      status: 'confirmed',
      price_cents: priceCents,
      // appointments has no 'source' column - this insert was rejected whole,
      // so voice booking NEVER worked. booked_via has a CHECK; 'voice_note'
      // is the allowed voice-ish value.
      booked_via: 'voice_note',
    })
    .select('id')
    .single();

  if (error) {
    logger.error({ err: error }, 'Voice book appointment insert failed');
    return { result: 'Something went wrong creating the booking.' };
  }

  const friendlyDate = startsAt.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const friendlyTime = startsAt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });

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

/**
 * Find THE appointment the beautician means. Scoped to a named day when
 * given; if she didn't name a day and the client has several upcoming
 * appointments, we ask instead of guessing. Guessing moved the WRONG
 * appointment in live testing (earliest-upcoming grabbed a different one).
 */
async function findTargetAppointment(beauticianId, clientId, appointmentDate, supabase) {
  let q = supabase
    .from('appointments')
    .select('id, starts_at, duration_minutes, treatments(name)')
    .eq('beautician_id', beauticianId)
    .eq('client_id', clientId)
    .in('status', ['confirmed', 'pending'])
    .order('starts_at', { ascending: true });
  if (appointmentDate) {
    q = q.gte('starts_at', `${appointmentDate}T00:00:00`).lte('starts_at', `${appointmentDate}T23:59:59`);
  } else {
    q = q.gte('starts_at', new Date().toISOString());
  }
  const { data: appts } = await q.limit(5);
  if (!appts || appts.length === 0) return { appt: null, ambiguous: false };
  if (!appointmentDate && appts.length > 1) return { appt: null, ambiguous: true, options: appts };
  return { appt: appts[0], ambiguous: false };
}

async function toolReschedule({ client_name, appointment_date, new_date, new_time, notify_client = true }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find a client called "${client_name}".` };

  const found = await findTargetAppointment(beautician.id, client.id, appointment_date || null, supabase);
  if (found.ambiguous) {
    const opts = found.options.map(a => new Date(a.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })).join(', ');
    return { result: `${client.first_name} has more than one upcoming appointment (${opts}). Which day did you mean?` };
  }
  const appt = found.appt;
  if (!appt) return { result: appointment_date ? `${client.first_name} has nothing booked on ${appointment_date}.` : `${client.first_name} has no upcoming appointments to reschedule.` };

  // WALL-TIME CONVENTION: starts_at stores the salon's wall clock inside a UTC
  // slot. Never round-trip through `new Date(local string).toISOString()`, which
  // converts, so 16:30 is stored as 15:30 in BST and the client is told an hour
  // out. Build the string directly instead.
  const resolvedDate = new_date || appt.starts_at.slice(0, 10);
  const resolvedTime = new_time || appt.starts_at.slice(11, 16);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(resolvedDate) || !/^\d{2}:\d{2}$/.test(resolvedTime)) {
    return { result: "Couldn't parse that date and time. Try something like 'Thursday at 2pm'." };
  }

  const newStartIso = `${resolvedDate}T${resolvedTime}:00.000Z`;
  const startMs = Date.parse(newStartIso);
  if (Number.isNaN(startMs)) {
    return { result: "Couldn't parse that date and time. Try something like 'Thursday at 2pm'." };
  }
  const durationMinutes = appt.duration_minutes || 60;
  const newEndIso = new Date(startMs + durationMinutes * 60000).toISOString();

  // Never move an appointment on top of another one. This used to move first
  // and tell the client afterwards, so a clash meant two people at one slot.
  const { data: clashes, error: clashError } = await supabase
    .from('appointments')
    .select('id, starts_at, ends_at')
    .eq('beautician_id', beautician.id)
    .neq('id', appt.id)
    .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
    .lt('starts_at', newEndIso)
    .gt('ends_at', newStartIso);

  if (clashError) {
    logger.warn({ err: clashError, appointmentId: appt.id }, 'Reschedule clash check failed');
    return { result: "I couldn't check the diary just then, so I have not moved anything. Try again in a moment." };
  }
  if (clashes?.length) {
    return { result: `That clashes with something already in the diary at ${resolvedTime}. Pick another time and I will move it.` };
  }

  const { error: updateError } = await supabase
    .from('appointments')
    .update({ starts_at: newStartIso, ends_at: newEndIso })
    .eq('id', appt.id);

  // Nothing below may claim the move happened unless the write actually
  // succeeded. The unique no-double-book index from migration 068 can reject
  // this, and the old code told the client "has been moved" regardless.
  if (updateError) {
    logger.error({ err: updateError, appointmentId: appt.id }, 'Voice reschedule FAILED to write');
    return { result: "I could not move that one, so nothing has changed. Worth checking the diary." };
  }

  const treatmentName = appt.treatments?.name || 'appointment';
  const friendly = new Date(newStartIso);
  const friendlyDate = friendly.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC',
  });
  // timeZone UTC because the wall clock is what is stored in the slot.
  const friendlyTime = friendly.toLocaleTimeString('en-GB', {
    hour: '2-digit', minute: '2-digit', timeZone: 'UTC',
  });

  if (notify_client) {
    await sendMessage({
      client,
      body: `Hi ${client.first_name}! Quick update, your ${treatmentName} has been moved to ${friendlyDate} at ${friendlyTime}. See you then!`,
      beauticianId: beautician.id,
      beauticianPrefs: beautician.client_reminder_prefs || {},
    }).catch(e => logger.warn({ err: e }, 'Reschedule notification failed'));
  }

  return {
    result: `Moved ${client.first_name}'s ${treatmentName} to ${friendlyDate} at ${friendlyTime}${notify_client ? '. Confirmation sent.' : '.'}`,
    data: { appointmentId: appt.id },
  };
}

async function toolCancelAppointment({ client_name, appointment_date, notify_client = true }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find "${client_name}".` };

  const found = await findTargetAppointment(beautician.id, client.id, appointment_date || null, supabase);
  if (found.ambiguous) {
    const opts = found.options.map(a => new Date(a.starts_at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })).join(', ');
    return { result: `${client.first_name} has more than one upcoming appointment (${opts}). Which day did you mean?` };
  }
  const appt = found.appt;
  if (!appt) return { result: appointment_date ? `${client.first_name} has nothing booked on ${appointment_date}.` : `${client.first_name} has no upcoming appointments to cancel.` };

  const { error: cancelError } = await supabase
    .from('appointments')
    .update({ status: 'cancelled' })
    .eq('id', appt.id);

  // Nothing below may claim the cancellation happened unless the write did.
  // Unchecked, a failed write still told the client "your appointment has been
  // cancelled": she stops coming, the booking sits live in the diary, and Ellie
  // waits in for somebody who is not turning up. toolReschedule above already
  // learned this lesson.
  if (cancelError) {
    logger.error({ err: cancelError, appointmentId: appt.id }, 'Voice cancel FAILED to write');
    return { result: "I could not cancel that one, so nothing has changed. Worth checking the diary." };
  }

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

async function toolBlockDate({ date, all_day, start_time, end_time, reason = 'personal', note }, beautician, supabase) {
  const isAllDay = all_day !== false && !start_time;

  const row = {
    beautician_id: beautician.id,
    date,
    type: isAllDay ? 'closed' : 'amended',
    is_closed: isAllDay,
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
    is_closed: true,
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

  // Get all clients. There is no clients.is_active column and there never was:
  // the flag this filter wanted is archived_at, which is how the rest of the
  // codebase (routes/clients.js, routes/florrie-thinks.js) says "still on the
  // books". Filtering on status = 'active' would have been wrong in the other
  // direction, because a lapsed client is exactly the one whose status has
  // already drifted to 'dormant'.
  const { data: clients, error: clientsErr } = await supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beautician.id)
    .is('archived_at', null)
    .limit(200);

  // Read the error. With the unknown column name PostgREST rejected the whole
  // select, clients came back null, and this tool answered "everyone's been in
  // recently" every single time.
  if (clientsErr) {
    logger.error({ err: clientsErr, beauticianId: beautician.id }, 'Lapsed clients query failed');
    return { result: 'I could not read your client list just now. Try again in a moment.' };
  }

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

  // There is no client_notes table: notes live on the client record. The old
  // insert failed every time, so voice notes were never saved.
  const stamp = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  const combined = client.notes ? `${client.notes}\n[${stamp}] ${note}` : `[${stamp}] ${note}`;
  const { error } = await supabase
    .from('clients')
    .update({ notes: combined })
    .eq('id', client.id)
    .eq('beautician_id', beautician.id);

  if (error) {
    logger.error({ err: error }, 'add_client_note failed');
    return { result: 'Could not save the note — something went wrong.' };
  }

  return { result: `Note added to ${client.first_name}'s record.` };
}

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
    // Same non-existent is_active column as above. Archived clients are the
    // ones to leave out of a bulk send; dormant ones are the whole point of it.
    const { data, error: segErr } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone, email')
      .eq('beautician_id', beautician.id)
      .is('archived_at', null)
      .limit(500);
    if (segErr) {
      logger.error({ err: segErr, beauticianId: beautician.id }, 'Bulk-message segment query failed');
      return { result: 'I could not read your client list just now, so I have sent nothing.' };
    }
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

  // Destination charge: the platform pays Stripe's processing fee, so the
  // application fee must recover it on top of Florrie's cut or this payment
  // loses the platform money (the arrears leak).
  const platformFee = totalApplicationFee(amount_pence);
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

  // The Stripe session exists by this point — the customer can already pay.
  // `.catch(() => {})` on a query builder is a TypeError, so a payment link
  // that HAD been created was reported to her as a failure, and the row that
  // lets the app recognise the payment later was never written.
  const { error: linkErr } = await supabase.from('payment_links').insert({
    beautician_id: beautician.id,
    client_id: client.id,
    amount_cents: amount_pence,
    description: desc,
    stripe_session_id: session.id,
    url: session.url,
    status: 'pending',
  });
  if (linkErr) logger.warn({ err: linkErr, sessionId: session.id }, 'Payment link created in Stripe but not recorded');

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
    // expenses has no 'source' column either - the same rejected-insert bug
    // as bookings: voice expense logging never worked until this line died.
  });

  if (error) {
    logger.error({ err: error }, 'create_expense failed');
    return { result: 'Could not log the expense — something went wrong.' };
  }

  return { result: `Logged £${(amount_pence / 100).toFixed(2)} expense: ${description} (${category}).` };
}

async function toolAddNote({ note }, beautician, supabase) {
  const today = new Date().toISOString().slice(0, 10);

  // daily_checklists is one row PER ITEM (label / list_type / done / sort_order),
  // not one row per day with an items array. There is no `items` column and no
  // `type` column, so the old insert was rejected whole and every note spoken
  // into Florrie was answered with "Added to today's checklist" and then thrown
  // away. Written here in the shape the DailyChecklist page actually reads.
  const { count } = await supabase
    .from('daily_checklists')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beautician.id)
    .eq('date', today)
    .eq('list_type', 'custom');

  const { error } = await supabase.from('daily_checklists').insert({
    beautician_id: beautician.id,
    date: today,
    list_type: 'custom',
    label: note,
    done: false,
    sort_order: count || 0,
  });

  // Never claim it landed without checking. That claim is the bug.
  if (error) {
    logger.error({ err: error, beauticianId: beautician.id }, 'Add note to checklist failed');
    return { result: 'I could not save that to your checklist just now. Say it again in a moment.' };
  }

  return { result: `Added to today's checklist: "${note}"` };
}

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
    dayCounts[new Date(a.starts_at).getUTCDay()]++; // wall-frame weekday
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

// ═══════════════════════════════════════════════
// CONSULTATION FORMS AND PATCH TESTS
//
// These five are the only tools here that touch health data. The rule they
// all follow: what comes back in `result` is spoken out loud, what comes back
// in `data` is only ever rendered on screen. So `result` carries the status
// and a COUNT, and the answers themselves stay in `data`.
//
// See services/voice-consultation.js for why that is a shape rather than an
// instruction in the prompt.
// ═══════════════════════════════════════════════

/**
 * findClient is a substring match that takes the FIRST row and never counts.
 * For "book Megan in" a wrong match is a booking she can move. For a medical
 * record it puts one client's allergies on screen while a different client
 * sits in the chair, so these two tools ask who else it could have been and
 * refuse rather than guess.
 */
async function resolveOneClient(beauticianId, name, supabase) {
  const client = await findClient(beauticianId, name, supabase);
  if (!client) return { error: `Can't find a client called "${name}".` };

  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  const { data: matches, error } = await supabase
    .from('clients')
    .select('id, first_name, last_name')
    .eq('beautician_id', beauticianId)
    .or(`first_name.ilike.%${cleaned}%,last_name.ilike.%${cleaned}%`)
    .limit(5);

  // A failed count must not silently become "only one match". Fall through to
  // the single client findClient already resolved and say the full name aloud,
  // which is what lets her catch it.
  if (error) return { client };

  const distinct = (matches || []).filter(m => m.id);
  if (distinct.length > 1) {
    const names = distinct.map(m => [m.first_name, m.last_name].filter(Boolean).join(' ')).join(', ');
    return { error: `I have more than one match for "${name}": ${names}. Which one?` };
  }
  return { client };
}

async function toolCheckConsultationForm({ client_name }, beautician, supabase) {
  const { client, error } = await resolveOneClient(beautician.id, client_name, supabase);
  if (error) return { result: error };
  return consultationStatusForClient({ supabase, beauticianId: beautician.id, client });
}

async function toolConsultationsNeeded({ start_date, end_date }, beautician, supabase) {
  return consultationsOutstanding({ supabase, beauticianId: beautician.id, start_date, end_date });
}

async function toolCheckPatchTest({ client_name }, beautician, supabase) {
  const { client, error } = await resolveOneClient(beautician.id, client_name, supabase);
  if (error) return { result: error };
  return patchTestStatusForClient({ supabase, beauticianId: beautician.id, client, logger });
}

async function toolPatchTestsNeeded({ start_date, end_date }, beautician, supabase) {
  return patchTestsOutstanding({ supabase, beauticianId: beautician.id, start_date, end_date, logger });
}

/**
 * Send the consultation form. Confirm-gated, so this only runs after she has
 * tapped the card.
 *
 * The two refusals below are checked HERE rather than left to the sender,
 * because the sender's failure arrives after the tap. She has three active
 * forms and no default one today, which is exactly the case that would
 * otherwise say "sending" and then not send.
 */
async function toolSendConsultationForm({ client_name }, beautician, supabase) {
  const client = await findClient(beautician.id, client_name, supabase);
  if (!client) return { result: `Can't find a client called "${client_name}".` };
  if (!client.phone) {
    return { result: `${client.first_name} has no mobile number on file, so there is nowhere to send it.` };
  }

  // Their next booking decides which form, the same way the booking flow does.
  const { data: next } = await supabase
    .from('appointments')
    .select('id, treatment_id, starts_at')
    .eq('beautician_id', beautician.id)
    .eq('client_id', client.id)
    // Wall-clock now, not midnight: an appointment that finished at 9am is not
    // their next booking, and picking it picks that treatment's form.
    .gte('starts_at', new Date().toISOString())
    .in('status', ['confirmed', 'pending'])
    .order('starts_at', { ascending: true })
    .limit(1);
  const appt = (next || [])[0] || null;

  const { formId } = await resolveSendableForm({
    supabase, beauticianId: beautician.id, treatmentId: appt?.treatment_id || null,
  });
  if (!formId) {
    return {
      result: 'There is no consultation form set up to send yet. Build one under More, then mark it as your default, and I can send it after that.',
    };
  }

  try {
    const sent = await sendConsultationFormSMS({
      beauticianId: beautician.id,
      clientId: client.id,
      appointmentId: appt?.id || null,
      clientPhone: client.phone,
      clientFirstName: client.first_name || 'there',
      treatmentId: appt?.treatment_id || null,
      beauticianName: beautician.business_name || beautician.first_name || 'your beautician',
    });
    if (!sent) {
      return { result: 'There is no consultation form set up to send yet. Build one under More and mark it as your default.' };
    }
    // Ids only. The token is the credential guarding the form, and the
    // answers do not exist yet.
    logger.info({ clientId: client.id }, 'Consultation form sent by voice');
    return {
      result: `Sent. ${client.first_name} has the form link on her phone.`,
      data: { client_id: client.id, sent: true },
    };
  } catch (err) {
    logger.error({ err, clientId: client.id }, 'Voice consultation form send failed');
    return { result: `That did not send. Try again from ${client.first_name}'s profile.` };
  }
}

export async function findClient(beauticianId, name, supabase) {
  if (!name) return null;
  const cleaned = String(name).trim().replace(/\s+/g, ' ');
  if (!cleaned) return null;

  const parts = cleaned.split(' ');
  const first = parts[0];
  const last = parts.length > 1 ? parts[parts.length - 1] : null;

  const base = () => supabase
    .from('clients')
    .select('id, first_name, last_name, phone, email')
    .eq('beautician_id', beauticianId);

  // 1) Full "First Last": match BOTH names. This is the common voice case
  //    ("Reschedule Caitlin Clark ...") that the old single-column search
  //    always missed, because no first_name equals the whole "Caitlin Clark".
  if (last) {
    const { data } = await base()
      .ilike('first_name', `${first}%`)
      .ilike('last_name', `${last}%`)
      .limit(1);
    if (data?.[0]) return data[0];
  }

  // 2) Whole string against first name then last name (first-name-only,
  //    nicknames stored in first_name, or a single given name).
  const { data: byFirstWhole } = await base().ilike('first_name', `%${cleaned}%`).limit(1);
  if (byFirstWhole?.[0]) return byFirstWhole[0];

  const { data: byLastWhole } = await base().ilike('last_name', `%${cleaned}%`).limit(1);
  if (byLastWhole?.[0]) return byLastWhole[0];

  // 3) Loosest: any token matches either name (e.g. "Clark", or just the
  //    first name when the surname is slightly off).
  const { data: byFirstTok } = await base().ilike('first_name', `%${first}%`).limit(1);
  if (byFirstTok?.[0]) return byFirstTok[0];

  if (last) {
    const { data: byLastTok } = await base().ilike('last_name', `%${last}%`).limit(1);
    if (byLastTok?.[0]) return byLastTok[0];
  }

  return null;
}
