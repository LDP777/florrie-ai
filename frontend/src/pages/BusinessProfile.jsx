/**
 * BusinessProfile — Business info, branding, social links.
 *
 * Sections:
 *   Info       — business name, tagline, phone, email, address
 *   Branding   — brand colour, booking page accent, logo upload placeholder
 *   Social     — Instagram, TikTok, Facebook, website links
 *   Booking    — booking page URL preview, share button
 *
 * Dev-mode mock data from DEV_BEAUTICIAN.
 */
import { useState, useEffect, useRef } from 'react';
import { useBeautician, updateRow, supabase } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const BRAND_COLOURS = [
  'var(--accent, #C76B8A)', '#E8A0BF', '#C4A882', '#8B7355',
  '#7B9E89', '#5B8F6F', '#6B8EC4', '#4A6FA5',
  '#9B8EC4', '#7B68AE', 'var(--text-primary, #2D2A26)', '#5A5550',
];

const SOCIAL_PLATFORMS = [
  { key: 'instagram', label: 'Instagram', icon: '📷', placeholder: '@ellindigo' },
  { key: 'tiktok', label: 'TikTok', icon: '🎵', placeholder: '@ellindigo' },
  { key: 'facebook', label: 'Facebook', icon: '📘', placeholder: 'Ellindigo Brows & Beauty' },
  { key: 'website', label: 'Website', icon: '🌐', placeholder: 'www.ellindigo.co.uk' },
];

export default function BusinessProfile() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading, refresh } = useBeautician();
  const [tab, setTab] = useState('info');

  // Info fields — initialised from beautician profile
  const [businessName, setBusinessName] = useState('');
  const [tagline, setTagline] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [address, setAddress] = useState('');

  // Branding
  const [brandColor, setBrandColor] = useState('#C4A882');
  const [logoPreview, setLogoPreview] = useState(null);
  const [logoUploading, setLogoUploading] = useState(false);
  const [logoError, setLogoError] = useState(null);
  const logoInputRef = useRef(null);

  // Socials
  const [socials, setSocials] = useState({ instagram: '', tiktok: '', facebook: '', website: '' });

  // Booking
  const [linkCopied, setLinkCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  // Hydrate from Supabase when beautician loads
  useEffect(() => {
    if (!beautician) return;
    setBusinessName(beautician.business_name || '');
    setTagline(beautician.tagline || '');
    setPhone(beautician.phone || '');
    setEmail(beautician.email || '');
    setAddress(beautician.address || '');
    setBrandColor(beautician.brand_color || '#C4A882');
    setLogoPreview(beautician.logo_url || null);
    const sp = beautician.social_links || {};
    setSocials({ instagram: sp.instagram || '', tiktok: sp.tiktok || '', facebook: sp.facebook || '', website: sp.website || '' });
  }, [beautician]);

  const bookingUrl = `florrie.ai/book/${beautician?.booking_slug || 'your-slug'}`;

  function handleCopy() {
    navigator.clipboard?.writeText(`https://${bookingUrl}`);
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  }

  async function handleLogoUpload(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { setLogoError('Image must be under 2MB'); return; }
    setLogoUploading(true);
    setLogoError(null);
    try {
      const ext = file.name.split('.').pop();
      const path = `${beautician.id}/logo.${ext}`;
      const { error: upErr } = await supabase.storage.from('logos').upload(path, file, { upsert: true, contentType: file.type });
      if (upErr) throw upErr;
      const { data: { publicUrl } } = supabase.storage.from('logos').getPublicUrl(path);
      // Bust cache by appending timestamp
      const url = `${publicUrl}?t=${Date.now()}`;
      setLogoPreview(url);
      await updateRow('beauticians', beautician.id, { logo_url: url });
      await refresh();
    } catch (err) {
      logger.error('Logo upload error:', err);
      setLogoError('Upload failed — please try again');
    } finally {
      setLogoUploading(false);
    }
  }

  async function handleSave() {
    if (!beautician) return;
    setSaving(true);
    try {
      await updateRow('beauticians', beautician.id, {
        business_name: businessName,
        tagline,
        phone,
        address,
        brand_color: brandColor,
        logo_url: logoPreview,
        social_links: socials,
      });
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('Save error:', err);
    } finally {
      setSaving(false);
    }
  }

  if (bLoading) return <p style={{ padding: 40, textAlign: 'center', color: 'var(--text-muted, #AAA5A0)' }}>Loading...</p>;

  const tabs = [
    { key: 'info', label: 'Info' },
    { key: 'branding', label: 'Branding' },
    { key: 'social', label: 'Social' },
    { key: 'booking', label: 'Booking' },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Business Profile</h1>
        <p style={s.sub}>Your public info, branding & social links</p>
      </div>

      {/* Hero card */}
      <div style={{ ...s.heroCard, background: `linear-gradient(135deg, ${brandColor}, ${brandColor}CC)` }}>
        <div style={s.heroLogo}>
          {logoPreview ? (
            <img src={logoPreview} alt="Logo" style={{ width: 48, height: 48, borderRadius: 24, objectFit: 'cover' }} />
          ) : (
            <span style={s.heroInitial}>{businessName[0] || 'F'}</span>
          )}
        </div>
        <span style={s.heroName}>{businessName || 'Your Business'}</span>
        {tagline && <span style={s.heroTagline}>{tagline}</span>}
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #AAA5A0)',
              borderBottom: tab === t.key ? '2px solid var(--accent, #C76B8A)' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Info tab */}
      {tab === 'info' && (
        <div style={s.section}>
          <Field label="Business name" value={businessName} onChange={setBusinessName} />
          <Field label="Tagline" value={tagline} onChange={setTagline} placeholder="A short description clients see" />
          <Field label="Phone" value={phone} onChange={setPhone} type="tel" />
          <Field label="Email" value={email} onChange={setEmail} type="email" />
          <Field label="Address" value={address} onChange={setAddress} placeholder="Shown on your booking page" />
        </div>
      )}

      {/* Branding tab */}
      {tab === 'branding' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>Brand colour</span>
            <span style={s.cardDesc}>Used on your booking page and client messages</span>
            <div style={s.colourGrid}>
              {BRAND_COLOURS.map(c => (
                <button
                  key={c}
                  onClick={() => setBrandColor(c)}
                  style={{
                    ...s.colourDot,
                    background: c,
                    border: brandColor === c ? '3px solid var(--text-primary, #2D2A26)' : '3px solid transparent',
                    boxShadow: brandColor === c ? '0 0 0 2px #fff' : 'none',
                  }}
                  aria-label={c}
                />
              ))}
            </div>
            <div style={s.customColour}>
              <span style={s.customLabel}>Custom:</span>
              <input
                type="color"
                value={brandColor}
                onChange={e => setBrandColor(e.target.value)}
                style={s.colourInput}
              />
              <span style={s.colourHex}>{brandColor}</span>
            </div>
          </div>

          <div style={s.card}>
            <span style={s.cardLabel}>Logo</span>
            <span style={s.cardDesc}>Appears on your booking page and receipts</span>
            <div style={s.logoUpload}>
              <div style={s.logoPlaceholder}>
                {logoPreview ? (
                  <img src={logoPreview} alt="Logo" style={{ width: 64, height: 64, borderRadius: 12, objectFit: 'cover' }} />
                ) : (
                  <span style={s.logoIcon}>📷</span>
                )}
              </div>
              <input
                ref={logoInputRef}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                style={{ display: 'none' }}
                onChange={handleLogoUpload}
              />
              <button
                style={{ ...s.uploadBtn, opacity: logoUploading ? 0.6 : 1, cursor: logoUploading ? 'not-allowed' : 'pointer' }}
                onClick={() => logoInputRef.current?.click()}
                disabled={logoUploading}
              >
                {logoUploading ? 'Uploading…' : 'Upload logo'}
              </button>
              {logoError && <span style={{ fontSize: 11, color: '#E57373' }}>{logoError}</span>}
              <span style={s.uploadHint}>PNG or JPG, 512×512 recommended</span>
            </div>
          </div>

          {/* Live preview */}
          <div style={s.card}>
            <span style={s.cardLabel}>Preview</span>
            <div style={s.brandPreview}>
              <div style={{ ...s.previewBar, background: brandColor }} />
              <div style={s.previewContent}>
                <span style={{ ...s.previewName, color: brandColor }}>{businessName}</span>
                <div style={{ ...s.previewButton, background: brandColor }}>Book Now</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Social tab */}
      {tab === 'social' && (
        <div style={s.section}>
          {SOCIAL_PLATFORMS.map(p => (
            <div key={p.key} style={s.socialRow}>
              <span style={s.socialIcon}>{p.icon}</span>
              <div style={{ flex: 1 }}>
                <span style={s.socialLabel}>{p.label}</span>
                <input
                  type="text"
                  value={socials[p.key]}
                  onChange={e => setSocials(prev => ({ ...prev, [p.key]: e.target.value }))}
                  placeholder={p.placeholder}
                  style={s.socialInput}
                />
              </div>
            </div>
          ))}
          <p style={s.socialNote}>
            These links appear on your booking page and in automated messages to clients.
          </p>
        </div>
      )}

      {/* Booking tab */}
      {tab === 'booking' && (
        <div style={s.section}>
          <div style={s.card}>
            <span style={s.cardLabel}>Your booking link</span>
            <div style={s.urlRow}>
              <span style={s.urlText}>{bookingUrl}</span>
              <button onClick={handleCopy} style={s.copyBtn}>
                {linkCopied ? '✓ Copied' : 'Copy'}
              </button>
            </div>
          </div>

          <div style={s.card}>
            <span style={s.cardLabel}>Share your booking page</span>
            <div style={s.shareGrid}>
              <button style={s.shareBtn}>📱 WhatsApp</button>
              <button style={s.shareBtn}>📷 Instagram</button>
              <button style={s.shareBtn}>📘 Facebook</button>
              <button style={s.shareBtn}>🔗 Copy link</button>
            </div>
          </div>

          {/* Mini booking page preview */}
          <div style={s.card}>
            <span style={s.cardLabel}>Booking page preview</span>
            <div style={s.bookingPreview}>
              <div style={{ ...s.bpHeader, background: `linear-gradient(135deg, ${brandColor}, ${brandColor}CC)` }}>
                <span style={s.bpName}>{businessName}</span>
                {tagline && <span style={s.bpTagline}>{tagline}</span>}
              </div>
              <div style={s.bpBody}>
                <div style={s.bpService}>
                  <span style={s.bpServiceName}>Lamination & Hybrid Dye</span>
                  <span style={s.bpServiceMeta}>60 min · £45</span>
                </div>
                <div style={s.bpService}>
                  <span style={s.bpServiceName}>Lash Lift & Tint</span>
                  <span style={s.bpServiceMeta}>60 min · £40</span>
                </div>
                <div style={{ ...s.bpBookBtn, background: brandColor }}>Select & Book</div>
              </div>
            </div>
          </div>
        </div>
      )}

      <button onClick={handleSave} disabled={saving} style={s.saveBtn}>
        {saving ? 'Saving...' : saved ? '✓ Saved' : 'Save changes'}
      </button>
    </div>
  );
}

function Field({ label, value, onChange, type = 'text', placeholder }) {
  return (
    <div style={s.fieldGroup}>
      <label style={s.fieldLabel}>{label}</label>
      <input
        type={type}
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        style={s.fieldInput}
      />
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  header: { marginBottom: 16 },
  title: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: 0,
  },
  sub: {
    fontSize: 13,
    color: 'var(--text-muted, #AAA5A0)',
    margin: '4px 0 0',
  },
  heroCard: {
    borderRadius: 16,
    padding: '24px 16px',
    textAlign: 'center',
    marginBottom: 16,
  },
  heroLogo: {
    width: 56,
    height: 56,
    borderRadius: 28,
    background: 'rgba(255,255,255,0.25)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 10px',
  },
  heroInitial: {
    fontSize: 24,
    fontWeight: 700,
    color: 'var(--bg-card, #fff)',
  },
  heroName: {
    display: 'block',
    fontSize: 18,
    fontWeight: 700,
    color: 'var(--bg-card, #fff)',
  },
  heroTagline: {
    display: 'block',
    fontSize: 12,
    color: '#ffffffCC',
    marginTop: 4,
  },
  tabBar: {
    display: 'flex',
    borderBottom: '1px solid var(--border, #F0ECE8)',
    marginBottom: 16,
  },
  tab: {
    flex: 1,
    padding: '10px 0',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 13,
    fontFamily: 'inherit',
    textAlign: 'center',
  },
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  card: {
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    padding: 16,
    border: '1px solid var(--border, #F0ECE8)',
  },
  cardLabel: {
    display: 'block',
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
    marginBottom: 2,
  },
  cardDesc: {
    display: 'block',
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
    marginBottom: 12,
  },
  fieldGroup: {
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    padding: '12px 16px',
    border: '1px solid var(--border, #F0ECE8)',
  },
  fieldLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted, #AAA5A0)',
    marginBottom: 4,
  },
  fieldInput: {
    width: '100%',
    padding: '8px 0',
    border: 'none',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text, #2D2A26)',
    boxSizing: 'border-box',
  },
  colourGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(6, 1fr)',
    gap: 10,
    marginBottom: 12,
  },
  colourDot: {
    width: 36,
    height: 36,
    borderRadius: 18,
    cursor: 'pointer',
    transition: 'transform 0.15s',
  },
  customColour: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  customLabel: {
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
  },
  colourInput: {
    width: 30,
    height: 30,
    border: 'none',
    borderRadius: 6,
    cursor: 'pointer',
    padding: 0,
  },
  colourHex: {
    fontSize: 13,
    fontWeight: 500,
    color: 'var(--text, #2D2A26)',
    fontFamily: 'monospace',
  },
  logoUpload: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '12px 0',
  },
  logoPlaceholder: {
    width: 72,
    height: 72,
    borderRadius: 14,
    background: 'var(--bg, var(--bg, #FAF8F5))',
    border: '2px dashed var(--border, #E8E4E0)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  logoIcon: { fontSize: 28 },
  uploadBtn: {
    padding: '8px 20px',
    borderRadius: 10,
    border: '1px solid var(--accent, #C76B8A)',
    background: 'transparent',
    color: 'var(--accent, #C76B8A)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  uploadHint: {
    fontSize: 11,
    color: 'var(--text-muted, #AAA5A0)',
  },
  brandPreview: {
    borderRadius: 10,
    overflow: 'hidden',
    border: '1px solid var(--border, #F0ECE8)',
    marginTop: 8,
  },
  previewBar: {
    height: 4,
  },
  previewContent: {
    padding: '12px 14px',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  previewName: {
    fontSize: 14,
    fontWeight: 700,
  },
  previewButton: {
    padding: '6px 14px',
    borderRadius: 8,
    color: 'var(--bg-card, #fff)',
    fontSize: 12,
    fontWeight: 600,
  },
  socialRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'var(--card-bg, #fff)',
    borderRadius: 14,
    border: '1px solid var(--border, #F0ECE8)',
  },
  socialIcon: { fontSize: 22 },
  socialLabel: {
    display: 'block',
    fontSize: 12,
    fontWeight: 500,
    color: 'var(--text-muted, #AAA5A0)',
  },
  socialInput: {
    width: '100%',
    padding: '6px 0',
    border: 'none',
    fontSize: 14,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'transparent',
    color: 'var(--text, #2D2A26)',
    boxSizing: 'border-box',
  },
  socialNote: {
    fontSize: 12,
    color: 'var(--text-muted, #AAA5A0)',
    textAlign: 'center',
    lineHeight: 1.5,
  },
  urlRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginTop: 8,
    padding: '10px 12px',
    background: 'var(--bg, var(--bg, #FAF8F5))',
    borderRadius: 10,
  },
  urlText: {
    flex: 1,
    fontSize: 14,
    fontWeight: 500,
    color: 'var(--accent, #C76B8A)',
  },
  copyBtn: {
    padding: '6px 14px',
    borderRadius: 8,
    border: '1px solid var(--accent, #C76B8A)',
    background: 'transparent',
    color: 'var(--accent, #C76B8A)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  shareGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
    marginTop: 8,
  },
  shareBtn: {
    padding: '10px 0',
    borderRadius: 10,
    border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--bg, var(--bg, #FAF8F5))',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'var(--text, #2D2A26)',
  },
  bookingPreview: {
    borderRadius: 12,
    overflow: 'hidden',
    border: '1px solid var(--border, #F0ECE8)',
    marginTop: 8,
  },
  bpHeader: {
    padding: '16px 14px 12px',
    textAlign: 'center',
  },
  bpName: {
    display: 'block',
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--bg-card, #fff)',
  },
  bpTagline: {
    display: 'block',
    fontSize: 11,
    color: '#ffffffBB',
    marginTop: 2,
  },
  bpBody: {
    padding: 12,
    background: 'var(--card-bg, #fff)',
  },
  bpService: {
    padding: '10px 0',
    borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  bpServiceName: {
    display: 'block',
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
  },
  bpServiceMeta: {
    display: 'block',
    fontSize: 11,
    color: 'var(--text-muted, #AAA5A0)',
    marginTop: 2,
  },
  bpBookBtn: {
    marginTop: 12,
    padding: '10px 0',
    borderRadius: 10,
    color: 'var(--bg-card, #fff)',
    fontSize: 13,
    fontWeight: 600,
    textAlign: 'center',
  },
  saveBtn: {
    width: '100%',
    padding: '14px 0',
    marginTop: 20,
    borderRadius: 12,
    border: 'none',
    background: 'linear-gradient(135deg, var(--accent, #C76B8A), var(--accent-hover, #B85D7B))',
    color: 'var(--bg-card, #fff)',
    fontSize: 15,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 4px 14px rgba(199,107,138,0.3)',
  },
};
