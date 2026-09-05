import { describe, it, expect } from 'vitest';
import { missingConsultationFields, consultationCoverage } from '../../src/lib/consultation-care.js';
import { submitConsultationFormSchema } from '../../src/lib/schemas.js';
import { shapeResponse } from '../../src/lib/consultation-answers.js';

describe('consultation evidence and submission', () => {
  const signature = 'data:image/png;base64,aGVsbG8=';
  it('accepts the actual public wire contract, including signature', () => {
    expect(submitConsultationFormSchema.safeParse({ answers: { q: 'No' }, signature_data: signature }).success).toBe(true);
    expect(submitConsultationFormSchema.safeParse({ responses: {} }).success).toBe(false);
    expect(submitConsultationFormSchema.safeParse({ answers: {}, signature_data: 'https://other/image' }).success).toBe(false);
  });
  it('requires signature in its own column, checks consent ticks and allows optional signatures', () => {
    const fields = [{ id: 'sig', type: 'signature', required: true }, { id: 'consent', type: 'checkbox', required: true }];
    expect(missingConsultationFields(fields, { consent: true }, signature)).toEqual([]);
    expect(missingConsultationFields(fields, { consent: false }, null).map(f => f.id)).toEqual(['sig', 'consent']);
    expect(missingConsultationFields([{ ...fields[0], required: false }], {}, null)).toEqual([]);
  });
  it('does not cover a lash appointment with a brow response, including extra treatments', () => {
    const treatments = [{ requires_consultation: true, consultation_form_id: 'brow' }, { requires_consultation: true, consultation_form_id: 'lash' }];
    expect(consultationCoverage(treatments, [{ form_id: 'brow' }]).missing).toEqual([treatments[1]]);
    expect(consultationCoverage(treatments, [{ form_id: 'brow' }, { form_id: 'lash' }]).covered).toBe(true);
  });
  it('reads original questions and consent after the template changes', () => {
    const row = { answers: { original: 'Latex' }, form_snapshot: { name: 'Original', consent_text: 'Original consent', consultation_form_fields: [{ id: 'original', label: 'Allergies?', type: 'text' }] }, consultation_forms: { name: 'Changed', consent_text: 'Changed consent', consultation_form_fields: [{ id: 'new', label: 'Medication?', type: 'text' }] } };
    const result = shapeResponse(row);
    expect(result.form_name).toBe('Original');
    expect(result.consent_text).toBe('Original consent');
    expect(result.pairs[0]).toMatchObject({ question: 'Allergies?', answer: 'Latex' });
  });
  it('retains orphaned historic answers without inventing their missing question', () => {
    expect(shapeResponse({ answers: { deleted: 'Latex' }, consultation_forms: { consultation_form_fields: [] } }).pairs[0]).toMatchObject({ question: 'Original question unavailable', answer: 'Latex' });
  });
});
