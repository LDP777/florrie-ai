import { useState, useEffect } from 'react';

/**
 * PhoneField — captures a phone number WITH its country code so it stores as
 * clean E.164 (+447418313493), which is what WhatsApp/SMS need. A client can
 * type "07418 313493" the normal British way and it still lands correctly.
 *
 * value/onChange deal in E.164. Defaults to UK (+44).
 */
const COUNTRIES = [
  { code: 'GB', flag: '🇬🇧', dial: '+44',  name: 'UK' },
  { code: 'IE', flag: '🇮🇪', dial: '+353', name: 'Ireland' },
  { code: 'US', flag: '🇺🇸', dial: '+1',   name: 'US/Canada' },
  { code: 'AU', flag: '🇦🇺', dial: '+61',  name: 'Australia' },
  { code: 'ES', flag: '🇪🇸', dial: '+34',  name: 'Spain' },
  { code: 'FR', flag: '🇫🇷', dial: '+33',  name: 'France' },
  { code: 'DE', flag: '🇩🇪', dial: '+49',  name: 'Germany' },
  { code: 'NL', flag: '🇳🇱', dial: '+31',  name: 'Netherlands' },
  { code: 'PT', flag: '🇵🇹', dial: '+351', name: 'Portugal' },
  { code: 'IT', flag: '🇮🇹', dial: '+39',  name: 'Italy' },
  { code: 'PL', flag: '🇵🇱', dial: '+48',  name: 'Poland' },
  { code: 'AE', flag: '🇦🇪', dial: '+971', name: 'UAE' },
  { code: 'IN', flag: '🇮🇳', dial: '+91',  name: 'India' },
];

function toDigits(s) { return (s || '').replace(/\D/g, '').replace(/^0+/, ''); }

function splitE164(value) {
  const v = (value || '').trim();
  if (!v) return { dial: '+44', national: '' };
  if (v.startsWith('+')) {
    const m = [...COUNTRIES].sort((a, b) => b.dial.length - a.dial.length).find(c => v.startsWith(c.dial));
    if (m) return { dial: m.dial, national: v.slice(m.dial.length) };
    return { dial: '+44', national: v.replace(/[^\d]/g, '') };
  }
  return { dial: '+44', national: v.replace(/[^\d]/g, '') };
}

export default function PhoneField({ value, onChange, style, error }) {
  const init = splitE164(value);
  const [dial, setDial] = useState(init.dial);
  const [national, setNational] = useState(init.national);

  function emit(d, n) {
    const digits = toDigits(n);
    onChange(digits ? `${d}${digits}` : '');
  }

  // Re-sync when the parent sets the value externally (e.g. a recognised client),
  // without looping on our own emits.
  useEffect(() => {
    const current = toDigits(national) ? `${dial}${toDigits(national)}` : '';
    if ((value || '') !== current) {
      const s = splitE164(value);
      setDial(s.dial);
      setNational(s.national);
    }
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  const border = error ? '#DC2626' : '#E8E4DF';
  return (
    <div style={{ display: 'flex', gap: 8 }}>
      <select
        value={dial}
        onChange={e => { setDial(e.target.value); emit(e.target.value, national); }}
        aria-label="Country code"
        style={{ ...style, flex: '0 0 104px', borderColor: border, paddingLeft: 10, paddingRight: 6, cursor: 'pointer' }}
      >
        {COUNTRIES.map(c => (
          <option key={c.code} value={c.dial}>{c.flag} {c.dial}</option>
        ))}
      </select>
      <input
        type="tel"
        inputMode="tel"
        placeholder="Phone number *"
        value={national}
        onChange={e => { setNational(e.target.value); emit(dial, e.target.value); }}
        style={{ ...style, flex: 1, borderColor: border }}
        required
      />
    </div>
  );
}
