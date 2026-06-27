/**
 * Consolidated Zod schemas for all core domain types.
 * This file centralizes validation schemas for Clients, Appointments,
 * Treatments, Transactions, and other shared entities.
 *
 * Import these schemas in routes to maintain consistency and avoid duplication.
 */

import { z } from 'zod';

/**
 * @typedef {Object} CreateClientInput
 * @property {string} first_name - Client's first name (required, max 100 chars)
 * @property {string} [last_name] - Client's last name (optional, max 100 chars)
 * @property {string} [email] - Client's email (optional, must be valid)
 * @property {string} [phone] - Client's phone (optional, max 30 chars)
 * @property {'whatsapp'|'sms'|'email'} [preferred_channel] - Preferred contact method
 * @property {string} [notes] - Client notes (optional, max 5000 chars)
 */
export const createClientSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(100).trim(),
  last_name: z.string().max(100).trim().optional().nullable(),
  email: z.string().email('Invalid email').optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  preferred_channel: z.enum(['whatsapp', 'sms', 'email']).optional().default('whatsapp'),
  notes: z.string().max(5000).optional().nullable(),
});

/**
 * @typedef {Object} UpdateClientInput
 * @property {string} [first_name] - Client's first name (optional)
 * @property {string} [last_name] - Client's last name (optional)
 * @property {string} [email] - Client's email (optional)
 * @property {string} [phone] - Client's phone (optional)
 * @property {'whatsapp'|'sms'|'email'} [preferred_channel] - Preferred contact method
 * @property {boolean} [marketing_consent] - Whether client opted in to marketing
 * @property {boolean} [health_data_consent] - Whether client consented to health data usage
 * @property {string} [notes] - Client notes (optional)
 * @property {'new'|'active'|'dormant'|'vip'} [status] - Client status
 * @property {Object} [preferences] - Client preferences (any format)
 * @property {Object} [life_events] - Life event tracking data
 */
export const updateClientSchema = z.object({
  first_name: z.string().min(1).max(100).trim().optional(),
  last_name: z.string().max(100).trim().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  preferred_channel: z.enum(['whatsapp', 'sms', 'email']).optional(),
  marketing_consent: z.boolean().optional(),
  health_data_consent: z.boolean().optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.enum(['new', 'active', 'dormant', 'vip']).optional(),
  preferences: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().nullable(),
  life_events: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])).optional().nullable(),
}).strict();

/**
 * @typedef {Object} ImportClientsInput
 * @property {Array} clients - Array of client objects to import
 * @property {'fresha'|'timely'|'csv'} [source] - Source system of the import
 */
export const importClientsSchema = z.object({
  clients: z.array(z.object({
    first_name: z.string().optional(),
    firstName: z.string().optional(),
    last_name: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    mobile: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    id: z.union([z.string(), z.number()]).optional(),
    external_id: z.union([z.string(), z.number()]).optional(),
  })).min(1, 'Provide at least one client'),
  source: z.enum(['fresha', 'timely', 'csv']).optional().default('csv'),
});


/**
 * @typedef {Object} BookingInput
 * @property {string} treatment_id - UUID of the treatment (required)
 * @property {Array<string>} [extra_treatment_ids] - Additional treatment UUIDs for multi-treatment bookings
 * @property {string} starts_at - ISO 8601 datetime for appointment start
 * @property {string} client_name - Client's name (required, max 200 chars)
 * @property {string} [client_email] - Client's email (optional)
 * @property {string} client_phone - Client's phone (required, 5-30 chars)
 * @property {string} [notes] - Booking notes (optional, max 2000 chars)
 * @property {Object} [consultation] - Consultation form responses
 * @property {Array} [add_ons] - Additional add-on services
 * @property {'deposit'|'full'} [payment_type] - Whether to charge deposit or full amount
 * @property {'card'|'cash'|'bank_transfer'} [payment_method] - Payment method
 * @property {string} [discount_code] - Promo code for discount
 * @property {boolean} [is_member] - Whether client is a membership member
 * @property {boolean} [photo_consent] - Whether client consented to photos
 * @property {string} [client_package_id] - UUID of client package if applicable
 */
export const bookingSchema = z.object({
  treatment_id: z.string().uuid('Invalid treatment ID'),
  extra_treatment_ids: z.array(z.string().uuid()).optional().default([]),
  starts_at: z.string().refine(
    v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) && !isNaN(Date.parse(v)),
    { message: 'Invalid date/time format — expected ISO 8601 (e.g. 2026-03-28T14:00:00)' }
  ),
  client_name: z.string().min(1, 'Name is required').max(200).trim(),
  client_email: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().email('Invalid email').nullable().optional().default(null)
  ),
  client_phone: z.string().min(5, 'Phone number too short').max(30).trim(),
  notes: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(2000).nullable().optional().default(null)
  ),
  consultation: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())])).optional().nullable().default(null),
  add_ons: z.array(z.object({
    id: z.string().uuid(),
    price_cents: z.number().int().min(0),
  })).optional().default([]),
  // Cloudflare Turnstile token. validate() replaces req.body with the parsed
  // result BEFORE verifyTurnstile runs, so this must survive Zod's stripping.
  'cf-turnstile-response': z.string().max(4096).optional(),
  // PECR: ticked consent box on the public booking form (optional, default off)
  marketing_opt_in: z.boolean().optional().default(false),
  payment_type: z.enum(['deposit', 'full']).optional().default('deposit'),
  payment_method: z.enum(['card', 'cash', 'bank_transfer']).optional().default('card'),
  discount_code: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(50).nullable().optional().default(null)
  ),
  is_member: z.boolean().optional().default(false),
  photo_consent: z.boolean().optional().default(false),
  client_package_id: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().uuid().nullable().optional().default(null)
  ),
});

/**
 * @typedef {Object} CompleteDayInput
 * @property {string} [date] - ISO date string (YYYY-MM-DD) for the day to complete (defaults to today)
 */
export const completeDaySchema = z.object({
  date: z.string().date().optional()
});

/**
 * @typedef {Object} ManualAppointmentInput
 * Beautician-entered appointment from the day calendar's plus button.
 * Either client_id (existing client) or client_name (quick-create) is required.
 * Times follow the wall-clock convention: date + time are stored as-is.
 * @property {string} [client_id] - UUID of an existing client
 * @property {string} [client_name] - Name for a quick-created client
 * @property {string} [client_phone] - Optional phone for a quick-created client
 * @property {string} treatment_id - UUID of the treatment (required)
 * @property {string} date - YYYY-MM-DD
 * @property {string} time - HH:MM (24h)
 * @property {number} duration_minutes - Duration in minutes (5-720)
 * @property {number} price_cents - Price in pence (editable, may differ from treatment)
 * @property {boolean} [send_confirmation] - Send the booking confirmation (default false)
 */
export const manualAppointmentSchema = z.object({
  client_id: z.string().uuid('Invalid client ID').optional().nullable(),
  client_name: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(200).trim().nullable().optional().default(null)
  ),
  client_phone: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(30).trim().nullable().optional().default(null)
  ),
  treatment_id: z.string().uuid('Invalid treatment ID'),
  date: z.string().date(),
  time: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Time must be HH:MM (24h)'),
  duration_minutes: z.number().int().min(5).max(720),
  price_cents: z.number().int().min(0).max(1000000),
  send_confirmation: z.boolean().optional().default(false),
  // Optional note. Used to record the full treatment list when more than one
  // treatment is booked into a single manual appointment.
  notes: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() === '' ? null : v),
    z.string().max(2000).trim().nullable().optional().default(null)
  ),
}).refine(
  (d) => d.client_id || d.client_name,
  { message: 'Pick a client or give a name for a new one' }
);


/**
 * @typedef {Object} TreatmentInput
 * @property {string} name - Treatment name (required, max 200 chars)
 * @property {string} [description] - Treatment description (optional, max 5000 chars)
 * @property {number} duration_minutes - Duration in minutes (1-480)
 * @property {number} [buffer_minutes] - Buffer time between appointments (0-120, default 0)
 * @property {number} price_cents - Price in cents
 * @property {number} [deposit_cents] - Deposit required in cents (default 0)
 * @property {string} [category] - Treatment category (optional, max 100 chars)
 * @property {number} [product_cost_cents] - Cost of products used (default 0)
 * @property {Array<string>} [contraindications] - Health contraindications (max 20)
 */
export const treatmentSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(480),
  buffer_minutes: z.number().int().min(0).max(120).optional().default(0),
  price_cents: z.number().int().min(0),
  deposit_cents: z.number().int().min(0).optional().default(0),
  category: z.string().max(100).nullable().optional(),
  product_cost_cents: z.number().int().min(0).optional().default(0),
  contraindications: z.array(z.string().max(200)).max(20).optional().default([])
});

/**
 * @typedef {Object} TreatmentUpdateInput
 * @property {string} [name] - Treatment name (optional)
 * @property {string} [description] - Treatment description (optional)
 * @property {number} [duration_minutes] - Duration in minutes (optional)
 * @property {number} [buffer_minutes] - Buffer time (optional)
 * @property {number} [price_cents] - Price in cents (optional)
 * @property {number} [deposit_cents] - Deposit in cents (optional)
 * @property {number} [deposit_percent] - Deposit as percentage (optional, 0-100)
 * @property {string} [category] - Treatment category (optional)
 * @property {number} [product_cost_cents] - Product cost (optional)
 * @property {Array<string>} [contraindications] - Contraindications (optional)
 * @property {boolean} [is_active] - Whether treatment is active (optional)
 * @property {boolean} [booking_enabled] - Whether clients can book (optional)
 * @property {number} [sort_order] - Display order (optional)
 * @property {boolean} [requires_consultation] - Whether consultation required (optional)
 * @property {string} [consultation_form_id] - Consultation form UUID (optional)
 */
export const treatmentUpdateSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  description: z.string().max(5000).nullable().optional(),
  duration_minutes: z.number().int().min(1).max(480).optional(),
  buffer_minutes: z.number().int().min(0).max(120).optional(),
  price_cents: z.number().int().min(0).optional(),
  deposit_cents: z.number().int().min(0).optional(),
  deposit_percent: z.number().min(0).max(100).optional(),
  category: z.string().max(100).nullable().optional(),
  product_cost_cents: z.number().int().min(0).optional(),
  contraindications: z.array(z.string().max(200)).max(20).optional(),
  is_active: z.boolean().optional(),
  booking_enabled: z.boolean().optional(),
  sort_order: z.number().int().min(0).optional(),
  requires_consultation: z.boolean().optional(),
  consultation_form_id: z.string().uuid().nullable().optional()
}).strict();


/**
 * @typedef {Object} SignupInput
 * @property {string} email - Email address (required, must be valid)
 * @property {string} password - Password (required, min 8 chars)
 * @property {string} firstName - First name (required, max 100 chars)
 * @property {string} [lastName] - Last name (optional, max 100 chars)
 * @property {string} [businessName] - Business name (optional, max 200 chars)
 */
export const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().max(100).trim().optional().default(''),
  businessName: z.string().max(200).trim().optional().nullable(),
});

/**
 * @typedef {Object} ProfileUpdateInput
 * @property {string} [first_name] - First name (optional)
 * @property {string} [last_name] - Last name (optional)
 * @property {string} [business_name] - Business name (optional)
 * @property {string} [phone] - Phone number (optional, max 30 chars)
 * @property {string} [avatar_url] - Avatar image URL (optional)
 * @property {string} [booking_slug] - Custom booking page slug (optional)
 * @property {Object} [working_hours] - Working hours by day of week (optional)
 * @property {string} [brand_color] - Brand color hex (optional, max 20 chars)
 * @property {string} [brand_font] - Brand font name (optional, max 50 chars)
 * @property {string} [logo_url] - Logo image URL (optional)
 * @property {number} [confidence_threshold] - AI confidence threshold (0-1, optional)
 * @property {boolean} [auto_reply_enabled] - Whether auto-reply is enabled (optional)
 */
export const profileUpdateSchema = z.object({
  first_name: z.string().min(1).max(100).trim().optional(),
  last_name: z.string().max(100).trim().optional(),
  business_name: z.string().max(200).trim().optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  avatar_url: z.string().url().optional().nullable(),
  booking_slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes').optional(),
  working_hours: z.record(z.string(), z.union([z.object({ start: z.string(), end: z.string() }), z.null()])).optional(),
  brand_color: z.string().max(20).optional(),
  brand_font: z.string().max(50).optional(),
  logo_url: z.string().url().optional().nullable(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  auto_reply_enabled: z.boolean().optional(),
}).strict();


const HMRC_CATEGORIES = [
  'cost_of_goods', 'premises', 'admin', 'travel', 'advertising',
  'professional_fees', 'insurance', 'interest', 'phone', 'other_expenses'
];

/**
 * @typedef {Object} ExpenseInput
 * @property {number} amount_cents - Amount in cents (required, positive)
 * @property {string} [vendor] - Vendor/supplier name (optional, max 200 chars)
 * @property {string} [description] - Expense description (optional, max 1000 chars)
 * @property {string} category - Expense category (required, max 100 chars)
 * @property {'cost_of_goods'|'premises'|'admin'|'travel'|'advertising'|'professional_fees'|'insurance'|'interest'|'phone'|'other_expenses'} [hmrc_category] - HMRC tax category
 * @property {string} date - Date of expense (YYYY-MM-DD format)
 * @property {boolean} [tax_deductible] - Whether expense is tax deductible (default true)
 */
export const expenseSchema = z.object({
  amount_cents: z.number().int().min(1, 'Amount must be positive'),
  vendor: z.string().max(200).nullable().optional(),
  description: z.string().max(1000).nullable().optional(),
  category: z.string().min(1).max(100),
  hmrc_category: z.enum(HMRC_CATEGORIES).nullable().optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}/, 'Date must be YYYY-MM-DD format'),
  tax_deductible: z.boolean().optional().default(true)
});


/**
 * @typedef {Object} PromoCodeInput
 * @property {string} code - Promo code (required, max 50 chars, auto-uppercased)
 * @property {'percentage'|'fixed'} discount_type - Type of discount
 * @property {number} discount_value - Discount value (positive integer)
 * @property {number} [max_uses] - Maximum number of uses (optional)
 * @property {string} valid_from - ISO 8601 datetime when code becomes valid
 * @property {string} valid_until - ISO 8601 datetime when code expires
 */
export const createPromoCodeSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50).toUpperCase(),
  discount_type: z.enum(['percentage', 'fixed'], { errorMap: () => ({ message: 'Must be percentage or fixed' }) }),
  discount_value: z.number().int().positive('Discount value must be positive'),
  max_uses: z.number().int().positive().optional().nullable(),
  valid_from: z.string().datetime('Invalid ISO datetime format'),
  valid_until: z.string().datetime('Invalid ISO datetime format'),
});

/**
 * @typedef {Object} PromoCodeUpdateInput
 * @property {boolean} [is_active] - Whether code is active (optional)
 * @property {number} [discount_value] - Discount value (optional)
 * @property {number} [max_uses] - Max uses (optional)
 * @property {string} [valid_from] - Start date (optional)
 * @property {string} [valid_until] - End date (optional)
 */
export const updatePromoCodeSchema = z.object({
  is_active: z.boolean().optional(),
  discount_value: z.number().int().positive().optional(),
  max_uses: z.number().int().positive().optional().nullable(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
}).strict();

/**
 * @typedef {Object} ValidatePromoCodeInput
 * @property {string} code - Promo code to validate (required)
 */
export const validatePromoCodeSchema = z.object({
  code: z.string().min(1, 'Code is required').toUpperCase(),
});


/**
 * @typedef {Object} ReferralConfigInput
 * @property {boolean} [referral_enabled] - Whether referral program is enabled
 * @property {'discount'|'free_addon'|'credit'|'none'} [referral_reward_type] - Type of reward
 * @property {number} [referral_reward_value_cents] - Reward value in cents (0-10000)
 */
export const referralConfigSchema = z.object({
  referral_enabled: z.boolean().optional(),
  referral_reward_type: z.enum(['discount', 'free_addon', 'credit', 'none']).optional(),
  referral_reward_value_cents: z.number().min(0).max(10000).optional(),
});


/**
 * @typedef {Object} ConsultationFormField
 * @property {'text'|'yes_no'|'multi_select'|'single_select'|'checkbox'|'text_block'|'signature'} type - Field type
 * @property {string} label - Field label (max 1000 chars)
 * @property {Array<string>} [options] - Available options (for select types)
 * @property {boolean} [required] - Whether field is required (default false)
 * @property {number} [sort_order] - Display order
 */

/**
 * @typedef {Object} CreateConsultationFormInput
 * @property {string} name - Form name (required, max 200 chars)
 * @property {string} [consent_text] - Consent text (optional, max 5000 chars)
 * @property {boolean} [is_default] - Whether to set as default form (optional)
 * @property {Array<ConsultationFormField>} [fields] - Form fields
 */
export const createConsultationFormSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  consent_text: z.string().max(5000).optional().nullable().default(null),
  is_default: z.boolean().optional().default(false),
  fields: z.array(z.object({
    type: z.enum(['text', 'yes_no', 'multi_select', 'single_select', 'checkbox', 'text_block', 'signature']),
    label: z.string().min(1).max(1000).trim(),
    options: z.array(z.string()).optional().default([]),
    required: z.boolean().optional().default(false),
    sort_order: z.number().int().optional().default(0),
  })).optional().default([]),
});

/**
 * @typedef {Object} SubmitConsultationFormInput
 * @property {Object} responses - Form responses (key-value pairs)
 */
export const submitConsultationFormSchema = z.object({
  responses: z.record(z.string(), z.union([z.string(), z.boolean(), z.array(z.string())]))
});


/**
 * @typedef {Object} PhotoConsentInput
 * @property {string} client_id - Client UUID (required)
 * @property {string[]} permitted_uses - Where the photos may be used (required, at least one)
 * @property {string} [method] - How consent was requested: 'digital' or 'paper'
 * @property {string} [notes] - Free-text note / message to the client
 */
export const createPhotoConsentSchema = z.object({
  client_id: z.string().uuid(),
  permitted_uses: z.array(z.string().min(1)).min(1),
  method: z.enum(['digital', 'paper']).optional(),
  notes: z.string().max(2000).optional(),
});

/**
 * @typedef {Object} RevokePhotoConsentInput
 * @property {string} [notes] - Reason the consent was withdrawn (optional)
 */
export const revokePhotoConsentSchema = z.object({
  notes: z.string().max(2000).optional(),
});


/**
 * @typedef {Object} LocationInput
 * @property {string} name - Location name (required, max 200 chars)
 * @property {string} [address] - Street address (optional, max 500 chars)
 * @property {string} [postcode] - Postal code (optional, max 20 chars)
 * @property {string} [city] - City name (optional, max 100 chars)
 * @property {Object} [working_hours] - Working hours by day
 */
export const createLocationSchema = z.object({
  name: z.string().min(1).max(200).trim(),
  address: z.string().max(500).optional().nullable(),
  postcode: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  working_hours: z.record(z.string(), z.union([z.object({ start: z.string(), end: z.string() }), z.null()])).optional(),
});

/**
 * @typedef {Object} LocationUpdateInput
 */
export const updateLocationSchema = z.object({
  name: z.string().min(1).max(200).trim().optional(),
  address: z.string().max(500).optional().nullable(),
  postcode: z.string().max(20).optional().nullable(),
  city: z.string().max(100).optional().nullable(),
  working_hours: z.record(z.string(), z.union([z.object({ start: z.string(), end: z.string() }), z.null()])).optional(),
});


/**
 * @typedef {Object} WaitlistSignupInput
 * @property {string} email - Email address (required)
 * @property {string} [name] - Name (optional, max 200 chars)
 * @property {string} [source] - Signup source (optional, max 100 chars, default 'landing_page')
 */
export const waitlistSchema = z.object({
  email: z.string().email('Invalid email address'),
  name: z.string().max(200).optional().nullable().default(null),
  source: z.string().max(100).optional().default('landing_page'),
});


/**
 * @typedef {Object} CourseEnrollmentInput
 * @property {string} name  - Student full name
 * @property {string} email - Student email (used for the deposit receipt and duplicate check)
 * @property {string} [phone]
 * @property {string} [notes]
 *
 * The course is identified by the URL path (:slug/:courseId), so it is not in
 * the body. This schema validates the student details the public page posts.
 */
export const enrollCourseSchema = z.object({
  name: z.string().trim().min(1, 'Please enter your name').max(120),
  email: z.string().trim().email('Please enter a valid email').max(200),
  phone: z.string().trim().max(40).optional().or(z.literal('')),
  notes: z.string().trim().max(2000).optional().or(z.literal('')),
});
