/** Required inputs share the public form's actual wire representation. */
export function missingConsultationFields(fields, answers = {}, signature = null) {
  return (fields || []).filter(field => {
    if (!field.required || field.type === 'text_block') return false;
    if (field.type === 'signature') return !signature;
    const value = answers[field.id];
    if (field.type === 'checkbox') return value !== true;
    return value == null || (typeof value === 'string' && !value.trim()) || (Array.isArray(value) && !value.length);
  });
}

export function consultationCoverage(treatments, responses) {
  const required = treatments.filter(t => t.requires_consultation);
  const missing = required.filter(t => !responses.some(r => !t.consultation_form_id || r.form_id === t.consultation_form_id));
  return { required, missing, covered: missing.length === 0 };
}
