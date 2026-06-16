import { useState, useEffect, useRef } from 'react';
import { useParams } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * ConsultationFormPublic - the client-facing form page.
 * Accessed via: /form/:token (no auth required)
 * Mobile-first, branded to the beautician's colours.
 *
 * Field types:
 *   text         → free text input
 *   yes_no       → Yes / No radio buttons
 *   checkbox     → single confirmation tick
 *   single_select → pick one from list (radio)
 *   multi_select → tick all that apply (checkboxes)
 *   text_block   → static paragraph (no answer needed)
 *   signature    → canvas signature pad
 */

export default function ConsultationFormPublic() {
  const { token } = useParams();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [completed, setCompleted] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [validationErrors, setValidationErrors] = useState([]);

  // Form data
  const [form, setForm] = useState(null);
  const [clientName, setClientName] = useState('');
  const [beautician, setBeautician] = useState(null);
  const [answers, setAnswers] = useState({});
  const [signatureData, setSignatureData] = useState(null);

  // Load form
  useEffect(() => {
    fetch(`${API_BASE}/api/consultation-forms/public/${token}`)
      .then(r => r.json())
      .then(data => {
        if (data.completed) {
          setCompleted(true);
        } else if (data.error) {
          setError(data.error);
        } else {
          setForm(data.form);
          setClientName(data.client_name || '');
          setBeautician(data.beautician);
        }
      })
      .catch(() => setError('Unable to load the form. Please try again.'))
      .finally(() => setLoading(false));
  }, [token]);

  // Update answer
  function setAnswer(fieldId, value) {
    setAnswers(prev => ({ ...prev, [fieldId]: value }));
    // Clear validation error for this field
    setValidationErrors(prev => prev.filter(e => e !== fieldId));
  }

  // Toggle multi-select option
  function toggleMultiOption(fieldId, option) {
    setAnswers(prev => {
      const current = Array.isArray(prev[fieldId]) ? prev[fieldId] : [];
      const next = current.includes(option)
        ? current.filter(o => o !== option)
        : [...current, option];
      return { ...prev, [fieldId]: next };
    });
    setValidationErrors(prev => prev.filter(e => e !== fieldId));
  }

  // Submit
  async function handleSubmit() {
    // Validate required fields
    const missing = [];
    for (const field of (form?.fields || [])) {
      if (!field.required || field.type === 'text_block') continue;
      const val = answers[field.id];
      if (val === undefined || val === null || val === '' ||
          (Array.isArray(val) && val.length === 0)) {
        missing.push(field.id);
      }
    }

    // Check signature if there's a signature field
    const hasSignatureField = form?.fields?.some(f => f.type === 'signature');
    if (hasSignatureField && !signatureData) {
      missing.push('signature');
    }

    if (missing.length > 0) {
      setValidationErrors(missing);
      // Scroll to first missing field
      const el = document.getElementById(`field-${missing[0]}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch(`${API_BASE}/api/consultation-forms/public/${token}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answers, signature_data: signatureData }),
      });

      const data = await res.json();
      if (res.ok) {
        setCompleted(true);
      } else {
        setError(data.error || 'Failed to submit form');
      }
    } catch {
      setError('Connection error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }

  const brandColor = beautician?.brand_color || '#C4A882';

  // Loading state
  if (loading) {
    return (
      <div style={{ ...styles.page, textAlign: 'center', paddingTop: 80 }}>
        <div style={styles.spinner} />
        <p style={{ color: '#9a9590', marginTop: 16 }}>Loading your form...</p>
      </div>
    );
  }

  // Error state
  if (error) {
    return (
      <div style={styles.page}>
        <div style={styles.errorCard}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>😔</div>
          <p style={styles.errorText}>{error}</p>
        </div>
      </div>
    );
  }

  // Completed state
  if (completed) {
    return (
      <div style={styles.page}>
        <div style={{ ...styles.successCard, borderTopColor: brandColor }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>✓</div>
          <h2 style={styles.successTitle}>All done!</h2>
          <p style={styles.successText}>
            Thanks{clientName ? `, ${clientName}` : ''}. Your form has been submitted to {beautician?.name || 'your beautician'}.
          </p>
          <p style={styles.successHint}>You can close this page now.</p>
        </div>
      </div>
    );
  }

  // Form view
  return (
    <div style={styles.page}>
      {/* Branded header */}
      <div style={{ ...styles.brandHeader, background: brandColor }}>
        {beautician?.logo ? (
          <img src={beautician.logo} alt="" style={styles.logo} />
        ) : (
          <h1 style={styles.brandName}>{beautician?.name}</h1>
        )}
      </div>

      {/* Form title */}
      <div style={styles.formHeader}>
        <h2 style={styles.formTitle}>{form?.name}</h2>
        {clientName && (
          <p style={styles.greeting}>Hi {clientName}, please fill in the form below before your appointment.</p>
        )}
      </div>

      {/* Fields */}
      <div style={styles.fields}>
        {(form?.fields || []).map(field => (
          <div
            key={field.id}
            id={`field-${field.id}`}
            style={{
              ...styles.fieldCard,
              ...(validationErrors.includes(field.id) ? styles.fieldCardError : {}),
            }}
          >
            {/* Field label */}
            {field.type !== 'signature' && (
              <label style={styles.fieldLabel}>
                {field.label}
                {field.required && <span style={styles.required}> *</span>}
              </label>
            )}

            {/* Text input */}
            {field.type === 'text' && (
              <input
                style={styles.textInput}
                value={answers[field.id] || ''}
                onChange={e => setAnswer(field.id, e.target.value)}
                placeholder="Type your answer..."
              />
            )}

            {/* Yes/No */}
            {field.type === 'yes_no' && (
              <div style={styles.radioGroup}>
                {['Yes', 'No'].map(opt => (
                  <label key={opt} style={{
                    ...styles.radioOption,
                    ...(answers[field.id] === opt ? { ...styles.radioOptionSelected, borderColor: brandColor } : {}),
                  }}>
                    <input
                      type="radio"
                      name={`field-${field.id}`}
                      checked={answers[field.id] === opt}
                      onChange={() => setAnswer(field.id, opt)}
                      style={styles.radioInput}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {/* Checkbox (single confirmation) */}
            {field.type === 'checkbox' && (
              <label style={styles.checkboxRow}>
                <input
                  type="checkbox"
                  checked={answers[field.id] === true}
                  onChange={e => setAnswer(field.id, e.target.checked)}
                  style={{ ...styles.checkboxInput, accentColor: brandColor }}
                />
                <span style={styles.checkboxText}>I confirm</span>
              </label>
            )}

            {/* Single select (radio list) */}
            {field.type === 'single_select' && (
              <div style={styles.optionsList}>
                {(field.options || []).map(opt => (
                  <label key={opt} style={{
                    ...styles.radioOption,
                    ...(answers[field.id] === opt ? { ...styles.radioOptionSelected, borderColor: brandColor } : {}),
                  }}>
                    <input
                      type="radio"
                      name={`field-${field.id}`}
                      checked={answers[field.id] === opt}
                      onChange={() => setAnswer(field.id, opt)}
                      style={styles.radioInput}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {/* Multi select (checkbox list) */}
            {field.type === 'multi_select' && (
              <div style={styles.optionsList}>
                {(field.options || []).map(opt => (
                  <label key={opt} style={{
                    ...styles.checkOption,
                    ...((answers[field.id] || []).includes(opt) ? { ...styles.checkOptionSelected, borderColor: brandColor } : {}),
                  }}>
                    <input
                      type="checkbox"
                      checked={(answers[field.id] || []).includes(opt)}
                      onChange={() => toggleMultiOption(field.id, opt)}
                      style={{ ...styles.checkboxInput, accentColor: brandColor }}
                    />
                    {opt}
                  </label>
                ))}
              </div>
            )}

            {/* Text block (static, not editable) */}
            {field.type === 'text_block' && (
              <div style={styles.textBlock}>{field.label}</div>
            )}

            {/* Signature */}
            {field.type === 'signature' && (
              <SignaturePad
                brandColor={brandColor}
                value={signatureData}
                onChange={setSignatureData}
                hasError={validationErrors.includes('signature')}
              />
            )}
          </div>
        ))}
      </div>

      {/* Consent text */}
      {form?.consent_text && (
        <div style={styles.consentBlock}>
          <p style={styles.consentText}>{form.consent_text}</p>
        </div>
      )}

      {/* Validation summary */}
      {validationErrors.length > 0 && (
        <div style={styles.validationMsg}>
          Please complete all required fields marked with *
        </div>
      )}

      {/* Submit */}
      <button
        style={{ ...styles.submitBtn, background: brandColor }}
        onClick={handleSubmit}
        disabled={submitting}
      >
        {submitting ? 'Submitting...' : 'Submit Form'}
      </button>

      {/* Footer */}
      <p style={styles.footer}>Powered by Florrie</p>
    </div>
  );
}

function SignaturePad({ brandColor, value, onChange, hasError }) {
  const canvasRef = useRef(null);
  const [drawing, setDrawing] = useState(false);
  const [hasDrawn, setHasDrawn] = useState(false);

  function getPos(e) {
    const rect = canvasRef.current.getBoundingClientRect();
    const touch = e.touches ? e.touches[0] : e;
    return {
      x: (touch.clientX - rect.left) * (canvasRef.current.width / rect.width),
      y: (touch.clientY - rect.top) * (canvasRef.current.height / rect.height),
    };
  }

  function startDraw(e) {
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const pos = getPos(e);
    ctx.beginPath();
    ctx.moveTo(pos.x, pos.y);
    setDrawing(true);
    setHasDrawn(true);
  }

  function draw(e) {
    if (!drawing) return;
    e.preventDefault();
    const ctx = canvasRef.current.getContext('2d');
    const pos = getPos(e);
    ctx.lineTo(pos.x, pos.y);
    ctx.strokeStyle = '#2d2a26';
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.stroke();
  }

  function endDraw() {
    if (!drawing) return;
    setDrawing(false);
    onChange(canvasRef.current.toDataURL('image/png'));
  }

  function clearSig() {
    const ctx = canvasRef.current.getContext('2d');
    ctx.clearRect(0, 0, canvasRef.current.width, canvasRef.current.height);
    onChange(null);
    setHasDrawn(false);
  }

  return (
    <div style={{ ...styles.sigContainer, ...(hasError ? { borderColor: '#e74c3c' } : {}) }}>
      <label style={styles.fieldLabel}>
        Signature <span style={styles.required}>*</span>
      </label>
      <canvas
        ref={canvasRef}
        width={600}
        height={200}
        style={styles.sigCanvas}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
      {hasDrawn && (
        <button style={{ ...styles.clearSigBtn, color: brandColor }} onClick={clearSig}>
          Clear signature
        </button>
      )}
      {!hasDrawn && (
        <p style={styles.sigHint}>Draw your signature above</p>
      )}
    </div>
  );
}

const styles = {
  page: {
    maxWidth: 520,
    margin: '0 auto',
    padding: 0,
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    background: '#faf9f7',
    minHeight: '100vh',
  },
  brandHeader: {
    padding: '28px 24px',
    textAlign: 'center',
  },
  logo: {
    height: 36,
    objectFit: 'contain',
  },
  brandName: {
    margin: 0,
    color: '#fff',
    fontSize: 20,
    fontWeight: 600,
    letterSpacing: '-0.3px',
  },
  formHeader: {
    padding: '24px 20px 8px',
  },
  formTitle: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-primary, #2d2a26)',
    margin: '0 0 6px',
  },
  greeting: {
    fontSize: 14,
    color: '#6b6560',
    margin: 0,
    lineHeight: 1.5,
  },
  fields: {
    padding: '8px 20px',
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  fieldCard: {
    background: 'var(--bg-card, #fff)',
    border: '1px solid #e8e5e0',
    borderRadius: 12,
    padding: '18px 16px',
  },
  fieldCardError: {
    borderColor: '#e74c3c',
    boxShadow: '0 0 0 1px #e74c3c',
  },
  fieldLabel: {
    display: 'block',
    fontSize: 15,
    fontWeight: 500,
    color: 'var(--text-primary, #2d2a26)',
    marginBottom: 10,
    lineHeight: 1.4,
  },
  required: {
    color: '#e74c3c',
    fontWeight: 700,
  },
  textInput: {
    width: '100%',
    fontSize: 15,
    padding: '10px 12px',
    border: '1px solid #e8e5e0',
    borderRadius: 8,
    fontFamily: 'inherit',
    color: 'var(--text-primary, #2d2a26)',
    background: '#faf9f7',
    outline: 'none',
    boxSizing: 'border-box',
  },
  radioGroup: {
    display: 'flex',
    gap: 10,
  },
  radioOption: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '10px 16px',
    border: '1.5px solid #e8e5e0',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 15,
    color: 'var(--text-primary, #2d2a26)',
    flex: 1,
    justifyContent: 'center',
    transition: 'border-color 0.15s, background 0.15s',
  },
  radioOptionSelected: {
    background: 'rgba(196, 168, 130, 0.08)',
    fontWeight: 600,
  },
  radioInput: {
    display: 'none',
  },
  optionsList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
  },
  checkOption: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    border: '1.5px solid #e8e5e0',
    borderRadius: 8,
    cursor: 'pointer',
    fontSize: 15,
    color: 'var(--text-primary, #2d2a26)',
    transition: 'border-color 0.15s, background 0.15s',
  },
  checkOptionSelected: {
    background: 'rgba(196, 168, 130, 0.08)',
    fontWeight: 500,
  },
  checkboxRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    cursor: 'pointer',
  },
  checkboxInput: {
    width: 20,
    height: 20,
  },
  checkboxText: {
    fontSize: 15,
    color: 'var(--text-primary, #2d2a26)',
  },
  textBlock: {
    fontSize: 14,
    color: '#6b6560',
    lineHeight: 1.7,
    padding: '4px 0',
  },
  consentBlock: {
    margin: '16px 20px',
    padding: '16px 18px',
    background: 'var(--bg-card, #fff)',
    border: '1px solid #e8e5e0',
    borderRadius: 12,
  },
  consentText: {
    fontSize: 13,
    color: '#6b6560',
    lineHeight: 1.7,
    margin: 0,
  },
  validationMsg: {
    margin: '12px 20px',
    padding: '10px 14px',
    background: '#fdf2f2',
    color: '#e74c3c',
    borderRadius: 8,
    fontSize: 14,
    fontWeight: 500,
    textAlign: 'center',
  },
  submitBtn: {
    display: 'block',
    width: 'calc(100% - 40px)',
    margin: '20px auto',
    padding: 16,
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  footer: {
    textAlign: 'center',
    fontSize: 12,
    color: '#a09a93',
    padding: '16px 0 32px',
  },

  // Signature
  sigContainer: {
    border: '1px solid #e8e5e0',
    borderRadius: 10,
    overflow: 'hidden',
    padding: '14px 14px 10px',
  },
  sigCanvas: {
    width: '100%',
    height: 120,
    borderRadius: 6,
    background: '#faf9f7',
    border: '1px dashed #d4d0cb',
    touchAction: 'none',
    cursor: 'crosshair',
  },
  clearSigBtn: {
    background: 'none',
    border: 'none',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '6px 0',
  },
  sigHint: {
    fontSize: 12,
    color: '#a09a93',
    textAlign: 'center',
    margin: '6px 0 0',
  },

  // States
  spinner: {
    width: 32,
    height: 32,
    border: '3px solid #e8e5e0',
    borderTopColor: '#C4A882',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    margin: '0 auto',
  },
  errorCard: {
    textAlign: 'center',
    padding: '48px 24px',
    margin: '40px 20px',
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid #e8e5e0',
  },
  errorText: {
    fontSize: 15,
    color: '#6b6560',
    lineHeight: 1.5,
  },
  successCard: {
    textAlign: 'center',
    padding: '48px 24px',
    margin: '40px 20px',
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    border: '1px solid #e8e5e0',
    borderTop: '4px solid',
  },
  successTitle: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text-primary, #2d2a26)',
    margin: '0 0 8px',
  },
  successText: {
    fontSize: 15,
    color: '#6b6560',
    lineHeight: 1.5,
    margin: '0 0 12px',
  },
  successHint: {
    fontSize: 13,
    color: '#a09a93',
    margin: 0,
  },
};
