/**
 * WhatsApp template registry.
 *
 * ONE place that knows, per message, what the body says and what order its
 * {{n}} parameters come in. Everything else (the Meta submission route, the
 * Meta send path, the Twilio send path, the inbox thread log) reads from here.
 *
 * WHY this file exists
 * --------------------
 * Every beautician's number sits on the SAME shared WABA, so a template name
 * is global to all tenants. The old _v3 starter pack baked the salon's own
 * name into the body text:
 *
 *   booking_confirmation_v3 = "Hi {{1}}! It's Ellindigo ..."
 *
 * Template creation skips names that already exist, so the second salon to
 * run the starter pack created nothing, then the send path happily upgraded
 * her _v2 sends to the approved _v3. Her clients received confirmations
 * signed with a different salon's name. A body cannot be edited once Meta
 * has approved it, so the fix is a new version.
 *
 * _v4 moves the salon name OUT of the body and INTO a parameter. One approved
 * template then serves every tenant, which also keeps us inside Meta's
 * per-WABA template limit and means one review queue rather than one per
 * customer.
 *
 * WHY the parameters are built here and not at each call site
 * ----------------------------------------------------------
 * The version we actually send is not known until send time: it depends on
 * what Meta has approved on the WABA at that moment. A caller cannot know
 * whether to pass 3 params (v2/v3) or 4 (v4). If the shapes disagree, Meta
 * rejects the send for parameter count and the client gets NOTHING. So the
 * caller describes the message with the same positional array it always used,
 * and this module remaps it to whatever version is going out.
 */

/**
 * Per message: the Meta category, the human label, the ordered parameter
 * fields for every version, and one renderer.
 *
 * The renderer is the single source of the wording. The Meta body is produced
 * by rendering it with "{{1}}", "{{2}}" ... in place of the values, so the
 * text a client reads on WhatsApp and the text we render locally (Twilio
 * free-form fallback, inbox thread log) can never drift apart.
 *
 * versions[x] is the ORDER of the {{n}} slots for that version. v2 and v3 are
 * historical shapes that still exist on the WABA: v2 is the plain original,
 * v3 has the salon name written into the body (so it is absent from the
 * params). Only v4 is created from now on.
 */
export const TEMPLATE_SPECS = {
  booking_confirmation: {
    category: 'UTILITY',
    label: 'Booking confirmation',
    blurb: 'Confirms an appointment',
    versions: {
      v2: ['first_name', 'date', 'time'],
      v3: ['first_name', 'date', 'time'],
      v4: ['first_name', 'business_name', 'date', 'time'],
    },
    render: (f) =>
      `Hi ${f.first_name}! It's ${f.business_name} 🌸 Your appointment is confirmed for ${f.date} at ${f.time}. Reply here if anything needs changing. See you then!`,
  },
  reminder_24h: {
    category: 'UTILITY',
    label: '24-hour reminder',
    blurb: 'Reminds a client the day before',
    versions: {
      v2: ['first_name', 'treatment', 'time'],
      v3: ['first_name', 'treatment', 'time'],
      v4: ['first_name', 'business_name', 'treatment', 'time'],
    },
    render: (f) =>
      `Hi ${f.first_name}, it's ${f.business_name}! A little reminder that your ${f.treatment} is tomorrow at ${f.time}. Reply if you need to reschedule. See you soon 🌸`,
  },
  gap_fill_offer: {
    category: 'MARKETING',
    label: 'Last-minute gap offer',
    blurb: 'Offers a freed-up slot',
    versions: {
      v2: ['first_name', 'day', 'time'],
      v3: ['first_name', 'day', 'time'],
      v4: ['first_name', 'business_name', 'day', 'time'],
    },
    render: (f) =>
      `Hi ${f.first_name}, it's ${f.business_name}! A spot has just opened up on ${f.day} at ${f.time}. Fancy it? Reply YES and it's yours, or tell me a time that suits.`,
  },
  rebook_nudge: {
    category: 'MARKETING',
    label: 'Rebook invite',
    blurb: 'Invites a client to book again',
    versions: {
      v2: ['first_name'],
      v3: ['first_name'],
      v4: ['first_name', 'business_name'],
    },
    render: (f) =>
      `Hi ${f.first_name}, it's ${f.business_name} 🌸 It's been a little while! Fancy getting booked back in? Reply here and I'll find you a time.`,
  },
  generic_message: {
    category: 'MARKETING',
    label: 'General message',
    blurb: 'A friendly general message',
    versions: {
      v2: ['first_name', 'message'],
      v3: ['first_name', 'message'],
      v4: ['first_name', 'business_name', 'message'],
    },
    render: (f) => `Hi ${f.first_name}! It's ${f.business_name} 🌸 ${f.message} Reply here anytime.`,
  },
};

/** The version the starter pack creates today. */
export const CURRENT_TEMPLATE_VERSION = 'v4';

/**
 * Versions an unversioned caller may be UPGRADED to, newest first.
 *
 * _v3 is deliberately absent, and this is the whole multi-tenancy fix.
 *
 * The Meta-approved _v3 body has the pilot salon's own name typed into it
 * (see the header). It is still listed in `versions` above because messages
 * were really sent on it and the inbox log has to render them, but it must
 * never be CHOSEN for a send: any tenant whose WABA reports _v3 approved and
 * _v4 still in review would have had her client read another salon's name.
 * A body cannot be edited after approval, so unreachability is the only fix.
 *
 * That leaves the chain as: _v4 if approved, otherwise the _v2 the caller
 * asked for, which is the plain original and names no salon (its parameter
 * list carries first name, date, time and nothing else). Sending on _v2 is
 * the same message every pilot client has received all year, minus the salon
 * name, which is the correct thing to do while _v4 is in review.
 *
 * Adding a _v5 means adding it here and to every spec above. It will only be
 * used if it takes the salon name as a PARAMETER, see isTenantSafeVersion.
 */
const UPGRADE_ORDER = ['v4'];

/**
 * May this version be sent on behalf of ANY tenant?
 *
 * The rule is derived rather than listed, so a future version cannot be added
 * silently and quietly reintroduce this bug: every body in this file greets
 * the client with the salon name, so a version that does not carry
 * `business_name` as a parameter is one whose body has a name written into
 * it. That is exactly what _v3 is, and it is why _v3 fails this test.
 *
 * _v2 is not a candidate for upgrade at all, it is the floor the caller
 * already asked for, so it never comes past here.
 */
export function isTenantSafeVersion(base, version) {
  const fields = TEMPLATE_SPECS[base]?.versions?.[version];
  return Array.isArray(fields) && fields.includes('business_name');
}

/**
 * The literal salon name a template body gives away, or null.
 *
 * For TEMPLATE BODIES only, the ones submitted to Meta, where every value a
 * client will read must arrive as a {{n}} parameter. A rendered message is a
 * different thing entirely and of course contains a real salon name.
 *
 * The check is structural rather than a list of known salons: it looks for
 * the shapes the copy uses to name the sender ("It's X", "from X", "with X",
 * "at X") followed by a capitalised literal instead of a placeholder. A list
 * of names would only ever catch the salon that already burned us.
 */
export function bodyLeaksSalonName(body) {
  const text = String(body || '');
  // Deliberately NOT case-insensitive: the capital on the literal is half the
  // signal, so only the leading word of each phrase is allowed either case.
  const m = text.match(
    /\b(?:[Ii]t['\u2019]?s|[Ff]rom|[Ww]ith|[Aa]t)\s+(?!\{\{)([A-Z][A-Za-z0-9&'\u2019.-]*(?:\s+[A-Z][A-Za-z0-9&'\u2019.-]*)*)/
  );
  return m ? m[1] : null;
}

/**
 * Example values Meta requires alongside every {{n}} placeholder. Keyed by
 * FIELD, not by position, because position now differs per template. Nothing
 * here names a real salon: these examples are visible to Meta reviewers and
 * to every tenant, so a pilot customer's name has no business being in them.
 */
const FIELD_EXAMPLES = {
  first_name: 'Sarah',
  business_name: 'Your Salon',
  date: 'Friday 6 June',
  time: '2pm',
  treatment: 'Brow Lamination',
  day: 'Monday',
  message: 'Your patch test is booked in for Monday at 10am.',
};

/** Readable slot names for UI previews, keyed by field. */
const FIELD_WORDS = {
  first_name: 'client name',
  business_name: 'your salon name',
  date: 'date',
  time: 'time',
  treatment: 'treatment',
  day: 'day',
  message: 'message',
};

/** "booking_confirmation_v4" -> { base: "booking_confirmation", version: "v4" } */
export function splitTemplateName(name) {
  const raw = String(name || '').trim().toLowerCase();
  const m = raw.match(/^(.*)_(v\d+)$/);
  if (!m) return { base: raw, version: null };
  return { base: m[1], version: m[2] };
}

/** The spec for a template name, or null when it is not one of ours. */
export function specFor(name) {
  const { base } = splitTemplateName(name);
  return TEMPLATE_SPECS[base] || null;
}

/**
 * The ordered parameter fields for a full template name, or null when we do
 * not know the template (custom templates a beautician wrote herself).
 */
export function paramFieldsFor(name) {
  const { base, version } = splitTemplateName(name);
  const spec = TEMPLATE_SPECS[base];
  if (!spec || !version) return null;
  return spec.versions[version] || null;
}

/** Named values from a positional array, e.g. ["Sarah","Fri","2pm"] -> {first_name:...}. */
export function fieldsFromParams(name, params, extra = {}) {
  const fields = paramFieldsFor(name) || [];
  const values = Array.isArray(params) ? params : [];
  const out = {};
  fields.forEach((f, i) => {
    if (values[i] !== undefined && values[i] !== null) out[f] = String(values[i]);
  });
  return { ...out, ...extra };
}

/**
 * Positional array for a template name from named values. Missing fields come
 * back as an empty string: WhatsApp rejects empty parameters, so callers log
 * loudly rather than pretending the send will work.
 */
export function paramsFor(name, fields) {
  const order = paramFieldsFor(name);
  if (!order) return null;
  return order.map((f) => (fields?.[f] === undefined || fields[f] === null ? '' : String(fields[f])));
}

/**
 * Remap the params a caller supplied for `requestedName` into the order
 * `sendAsName` expects, filling the salon name from the beautician record.
 *
 * Returns null when the remap is not possible (unknown template, or params
 * that are not an array), which the send path treats as "do not upgrade".
 */
export function adaptParams({ requestedName, sendAsName, params, businessName }) {
  if (!Array.isArray(params)) return null;
  if (!paramFieldsFor(requestedName)) return null;
  const fields = fieldsFromParams(requestedName, params, {});
  const name = String(businessName || '').trim();
  // Only fill business_name when we actually have one. An empty parameter is
  // rejected by Meta, and "It's ." reads worse than not upgrading at all.
  if (name) fields.business_name = name;
  return paramsFor(sendAsName, fields);
}

/**
 * Pick the best version of a template that can actually be sent right now.
 *
 * `isAvailable(name)` answers "can this exact template go out": APPROVED on
 * the sending WABA for Meta, or mapped to a ContentSid for Twilio. Only the
 * _v2 names the callers use get upgraded; an explicit request for a specific
 * version is honoured as-is.
 *
 * The fallback is load-bearing, not theoretical: _v4 sits in Meta review for
 * hours after submission, and during that window every tenant must keep
 * sending the version their WABA has approved.
 */
export function chooseTemplateVersion(requestedName, isAvailable) {
  const { base, version } = splitTemplateName(requestedName);
  const spec = TEMPLATE_SPECS[base];
  if (!spec || version !== 'v2') return requestedName;
  for (const candidate of UPGRADE_ORDER) {
    if (!spec.versions[candidate]) continue;
    // Belt and braces with UPGRADE_ORDER. A version whose body names the
    // salon itself can never be sent for a tenant who is not that salon, so
    // it is skipped even if somebody adds it to the list above.
    if (!isTenantSafeVersion(base, candidate)) continue;
    const name = `${base}_${candidate}`;
    if (isAvailable(name)) return name;
  }
  return requestedName;
}

/**
 * Render the real message text for a template name and named values. Used for
 * the Twilio free-form fallback and for the inbox thread log, so the salon
 * sees the exact words her client saw.
 */
export function renderTemplateBody(name, fields) {
  const spec = specFor(name);
  if (!spec) return null;
  const order = paramFieldsFor(name) || spec.versions[CURRENT_TEMPLATE_VERSION];
  const values = {};
  for (const f of new Set([...order, ...Object.keys(fields || {})])) {
    values[f] = fields?.[f] === undefined || fields[f] === null ? '' : String(fields[f]);
  }
  if (!values.business_name) values.business_name = 'your salon';
  // Tidy the double space an empty slot leaves behind, but only spaces: a
  // free-text message can carry line breaks and they must survive.
  return spec.render(values).replace(/ {2,}/g, ' ').trim();
}

/**
 * The body text submitted to Meta: the same renderer, with "{{1}}", "{{2}}"
 * ... in the parameter slots. Generated rather than hand-written so the copy
 * and the placeholder numbering cannot disagree.
 */
export function metaBodyFor(name) {
  const order = paramFieldsFor(name);
  const spec = specFor(name);
  if (!order || !spec) return null;
  const slots = {};
  order.forEach((f, i) => { slots[f] = `{{${i + 1}}}`; });
  return spec.render(slots);
}

/** Meta example values, in parameter order. */
export function exampleValuesFor(name) {
  const order = paramFieldsFor(name) || [];
  return order.map((f, i) => FIELD_EXAMPLES[f] || `Example ${i + 1}`);
}

/** Readable slot words, in parameter order, for the UI preview. */
export function slotWordsFor(name) {
  const order = paramFieldsFor(name) || [];
  return order.map((f) => FIELD_WORDS[f] || 'detail');
}

/**
 * The starter pack every salon submits. Shared across all tenants now that no
 * salon name is baked into a body, so the second customer onwards finds them
 * already approved and sends immediately.
 */
export function starterPack(version = CURRENT_TEMPLATE_VERSION) {
  return Object.entries(TEMPLATE_SPECS)
    .filter(([, spec]) => !!spec.versions[version])
    .map(([base, spec]) => {
      const name = `${base}_${version}`;
      const body = metaBodyFor(name);
      // Nothing with a salon name written into it is ever submitted to Meta
      // again. An approved body cannot be edited, so the only moment this can
      // be stopped is before it is sent for review.
      const leak = bodyLeaksSalonName(body);
      if (leak) {
        throw new Error(`${name} names "${leak}" in its body; the salon name must be a parameter`);
      }
      return {
        name,
        category: spec.category,
        label: spec.label,
        body,
        examples: exampleValuesFor(name),
      };
    });
}

/** Every name in the current pack, for UI checks. */
export function starterPackNames(version = CURRENT_TEMPLATE_VERSION) {
  return starterPack(version).map((t) => t.name);
}
