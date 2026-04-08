import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';

const FLORRIE_LOGO_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 80" fill="none" style="height:40px;width:auto;">
  <g transform="translate(8,8) scale(0.8)">
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.75" transform="rotate(0 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(72 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(144 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(216 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(288 40 40)"/>
    <circle cx="40" cy="40" r="6.4" fill="#C9A96E"/>
  </g>
  <text x="80" y="52" font-family="'Playfair Display',Georgia,serif" font-size="36" font-weight="500" fill="#2D2A26" letter-spacing="-0.5">florrie</text>
  <text x="224" y="52" font-family="'DM Sans',sans-serif" font-size="24" font-weight="300" fill="#C76B8A" letter-spacing="0.5">.ai</text>
</svg>`;

const FLORRIE_LOGO_WHITE_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 80" fill="none" style="height:36px;width:auto;">
  <g transform="translate(8,8) scale(0.8)">
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#fff" opacity="0.75" transform="rotate(0 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#fff" opacity="0.65" transform="rotate(72 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#fff" opacity="0.55" transform="rotate(144 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#fff" opacity="0.55" transform="rotate(216 40 40)"/>
    <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#fff" opacity="0.65" transform="rotate(288 40 40)"/>
    <circle cx="40" cy="40" r="6.4" fill="#C9A96E"/>
  </g>
  <text x="80" y="52" font-family="'Playfair Display',Georgia,serif" font-size="36" font-weight="500" fill="#fff" letter-spacing="-0.5">florrie</text>
  <text x="224" y="52" font-family="'DM Sans',sans-serif" font-size="24" font-weight="300" fill="#C9A96E" letter-spacing="0.5">.ai</text>
</svg>`;

export default function LandingPage() {
  const navigate = useNavigate();
  const [pricing, setPricing] = useState('monthly');

  const priceData = {
    monthly: { price: '£29', period: '/month', note: 'Includes 120 AI messages/month. 10p per message after that.' },
    annual:  { price: '£290', period: '/year',  note: 'Includes 120 AI messages/month. 10p per message after that. 2 months free vs monthly.' },
  };

  useEffect(() => {
    // Tailwind CDN (v3) + config
    if (!document.getElementById('tw-cdn')) {
      const s = document.createElement('script');
      s.id = 'tw-cdn';
      s.src = 'https://cdn.tailwindcss.com?plugins=forms,container-queries';
      document.head.appendChild(s);
      s.onload = () => {
        if (window.tailwind) {
          window.tailwind.config = {
            darkMode: 'class',
            theme: {
              extend: {
                colors: {
                  'on-background': '#1c1c1a', 'surface-container-lowest': '#ffffff',
                  'surface-container-high': '#eae8e5', 'inverse-on-surface': '#f3f0ed',
                  'outline-variant': '#d8c1c6', 'surface-container': '#f0edea',
                  'on-secondary-fixed-variant': '#5a4312', 'on-error': '#ffffff',
                  'surface-variant': '#e5e2df', 'background': '#fcf9f6',
                  'primary-container': '#b05877', 'secondary-fixed': '#ffdea4',
                  'on-surface-variant': '#534247', 'on-primary-container': '#fffbff',
                  'on-error-container': '#93000a', 'primary': '#92405e',
                  'on-primary': '#ffffff', 'primary-fixed-dim': '#ffb1c8',
                  'surface-bright': '#fcf9f6', 'surface-dim': '#dcdad7',
                  'primary-fixed': '#ffd9e2', 'secondary-container': '#fedb9b',
                  'surface-container-highest': '#e5e2df', 'inverse-surface': '#31302f',
                  'outline': '#867277', 'tertiary': '#605a5e',
                  'surface-container-low': '#f6f3f0', 'on-secondary': '#ffffff',
                  'on-primary-fixed': '#3e001d', 'on-primary-fixed-variant': '#782b49',
                  'on-surface': '#1c1c1a', 'error': '#ba1a1a',
                  'surface': '#fcf9f6', 'secondary': '#745a27',
                  'on-secondary-container': '#795f2b', 'inverse-primary': '#ffb1c8',
                },
                borderRadius: { 'DEFAULT': '0.125rem', 'lg': '0.25rem', 'xl': '0.5rem', 'full': '0.75rem' },
                fontFamily: {
                  'headline': ['Newsreader', 'serif'],
                  'body': ['Plus Jakarta Sans', 'sans-serif'],
                  'label': ['Plus Jakarta Sans', 'sans-serif'],
                },
              },
            },
          };
        }
      };
    }

    // Material Symbols
    if (!document.getElementById('material-symbols')) {
      const l = document.createElement('link');
      l.id = 'material-symbols';
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:wght,FILL@100..700,0..1&display=swap';
      document.head.appendChild(l);
    }

    // Google Fonts (Newsreader + Plus Jakarta Sans + Playfair + DM Sans)
    if (!document.getElementById('landing-fonts')) {
      const l = document.createElement('link');
      l.id = 'landing-fonts';
      l.rel = 'stylesheet';
      l.href = 'https://fonts.googleapis.com/css2?family=Newsreader:ital,opsz,wght@1,6..72,200..800&family=Plus+Jakarta+Sans:wght@300;400;500;600;700&family=Playfair+Display:ital,wght@0,500;1,400&family=DM+Sans:wght@300;400&display=swap';
      document.head.appendChild(l);
    }

    // Custom CSS (keyframes + base landing styles)
    const styleId = 'landing-page-css-v2';
    if (!document.getElementById(styleId)) {
      const style = document.createElement('style');
      style.id = styleId;
      style.textContent = `
        #landing-root { position:fixed; inset:0; z-index:9990; overflow-y:auto; overflow-x:hidden;
          font-family:'Plus Jakarta Sans',sans-serif; background-color:#fcf9f6; color:#1c1c1a;
          line-height:1.65; font-size:17px; -webkit-font-smoothing:antialiased; }
        #landing-root h1,#landing-root h2,#landing-root h3 { font-family:'Newsreader',serif; }
        #landing-root .font-serif { font-family:'Newsreader',serif; }
        #landing-root .shadow-florrie { box-shadow:0 4px 20px rgba(146,64,94,0.06); }
        #landing-root .material-symbols-outlined { font-variation-settings:'FILL' 0,'wght' 400,'GRAD' 0,'opsz' 24; }
        @keyframes hub-pulse {
          0%,100% { box-shadow:0 0 30px 6px rgba(199,107,138,0.4); }
          50%      { box-shadow:0 0 60px 20px rgba(199,107,138,0.2); }
        }
        @keyframes float-a { 0%,100%{transform:translate(-50%,-50%) translateY(0)} 50%{transform:translate(-50%,-50%) translateY(-10px)} }
        @keyframes float-b { 0%,100%{transform:translate(-50%,-50%) translateY(0)} 50%{transform:translate(-50%,-50%) translateY(-8px)} }
        @keyframes float-c { 0%,100%{transform:translate(-50%,-50%) translateY(0)} 50%{transform:translate(-50%,-50%) translateY(-12px)} }
        @keyframes float-d { 0%,100%{transform:translate(-50%,-50%) translateY(0)} 50%{transform:translate(-50%,-50%) translateY(-9px)} }
        @keyframes float-e { 0%,100%{transform:translate(-50%,-50%) translateY(0)} 50%{transform:translate(-50%,-50%) translateY(-11px)} }
        @keyframes dot-pulse { 0%,100%{opacity:1} 50%{opacity:0.3} }
        @keyframes dash-flow { to{stroke-dashoffset:-16} }
        @keyframes slide-in-left  { from{opacity:0;transform:translateX(-12px)} to{opacity:1;transform:translateX(0)} }
        @keyframes slide-in-right { from{opacity:0;transform:translateX(12px)}  to{opacity:1;transform:translateX(0)} }
        .agent-hub  { animation:hub-pulse 3s ease-in-out infinite; }
        .agent-1 { animation:float-a 5s ease-in-out infinite; animation-delay:0s; }
        .agent-2 { animation:float-b 6s ease-in-out infinite; animation-delay:0.8s; }
        .agent-3 { animation:float-c 5.5s ease-in-out infinite; animation-delay:1.6s; }
        .agent-4 { animation:float-d 6.5s ease-in-out infinite; animation-delay:2.4s; }
        .agent-5 { animation:float-e 5.2s ease-in-out infinite; animation-delay:3.2s; }
        .online-dot  { animation:dot-pulse 2s ease-in-out infinite; }
        .online-dot-2{ animation:dot-pulse 2s ease-in-out infinite; animation-delay:0.5s; }
        .online-dot-3{ animation:dot-pulse 2s ease-in-out infinite; animation-delay:1s; }
        .online-dot-4{ animation:dot-pulse 2s ease-in-out infinite; animation-delay:1.5s; }
        .online-dot-5{ animation:dot-pulse 2s ease-in-out infinite; animation-delay:0.3s; }
        .agent-line   { animation:dash-flow 1.2s linear infinite; }
        .agent-line-2 { animation:dash-flow 1.4s linear infinite; }
        .agent-line-3 { animation:dash-flow 1.1s linear infinite; }
        .agent-line-4 { animation:dash-flow 1.5s linear infinite; }
        .agent-line-5 { animation:dash-flow 1.3s linear infinite; }
        .msg-1 { animation:slide-in-left  0.5s 0.3s ease both; }
        .msg-2 { animation:slide-in-right 0.5s 1.2s ease both; opacity:0; }
        .msg-3 { animation:slide-in-left  0.5s 2.2s ease both; opacity:0; }
        .msg-4 { animation:slide-in-right 0.5s 3.3s ease both; opacity:0; }
      `;
      document.head.appendChild(style);
    }

    // Set page title
    const prevTitle = document.title;
    document.title = 'Florrie | AI Business Assistant for Beauty Professionals';

    // Intercept in-app links so React Router handles them
    const root = document.getElementById('landing-root');
    const handleClick = (e) => {
      const a = e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href');
      if (href === '/login' || href === '/signup') {
        e.preventDefault();
        navigate(href);
      }
    };
    root?.addEventListener('click', handleClick);

    return () => {
      document.title = prevTitle;
      root?.removeEventListener('click', handleClick);
    };
  }, [navigate]);

  const { price, period, note } = priceData[pricing];

  const FloLogo = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 80" fill="none" className="h-10 w-auto">
      <g transform="translate(8,8) scale(0.8)">
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.75" transform="rotate(0 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(72 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(144 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(216 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(288 40 40)"/>
        <circle cx="40" cy="40" r="6.4" fill="#C9A96E"/>
      </g>
      <text x="80" y="52" fontFamily="'Playfair Display',Georgia,serif" fontSize="36" fontWeight="500" fill="#2D2A26" letterSpacing="-0.5">florrie</text>
      <text x="224" y="52" fontFamily="'DM Sans',sans-serif" fontSize="24" fontWeight="300" fill="#C76B8A" letterSpacing="0.5">.ai</text>
    </svg>
  );

  const FloLogoFooter = () => (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 340 80" fill="none" className="h-9 w-auto">
      <g transform="translate(8,8) scale(0.8)">
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.75" transform="rotate(0 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(72 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(144 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.55" transform="rotate(216 40 40)"/>
        <ellipse cx="40" cy="20" rx="12.8" ry="19.2" fill="#C76B8A" opacity="0.65" transform="rotate(288 40 40)"/>
        <circle cx="40" cy="40" r="6.4" fill="#C9A96E"/>
      </g>
      <text x="80" y="52" fontFamily="'Playfair Display',Georgia,serif" fontSize="36" fontWeight="500" fill="#2D2A26" letterSpacing="-0.5">florrie</text>
      <text x="224" y="52" fontFamily="'DM Sans',sans-serif" fontSize="24" fontWeight="300" fill="#C76B8A" letterSpacing="0.5">.ai</text>
    </svg>
  );

  const PetalIcon = ({ className = 'w-14 h-14' }) => (
    <svg viewBox="0 0 100 100" fill="none" className={className}>
      <ellipse cx="50" cy="30" rx="16" ry="24" fill="#fff" opacity="0.85" transform="rotate(0 50 50)"/>
      <ellipse cx="50" cy="30" rx="16" ry="24" fill="#fff" opacity="0.75" transform="rotate(72 50 50)"/>
      <ellipse cx="50" cy="30" rx="16" ry="24" fill="#fff" opacity="0.65" transform="rotate(144 50 50)"/>
      <ellipse cx="50" cy="30" rx="16" ry="24" fill="#fff" opacity="0.65" transform="rotate(216 50 50)"/>
      <ellipse cx="50" cy="30" rx="16" ry="24" fill="#fff" opacity="0.75" transform="rotate(288 50 50)"/>
      <circle cx="50" cy="50" r="8" fill="#C9A96E"/>
    </svg>
  );

  const Icon = ({ name, className = '', style = {} }) => (
    <span className={`material-symbols-outlined ${className}`} style={style}>{name}</span>
  );

  const StarFilled = () => (
    <Icon name="star" style={{ fontVariationSettings: "'FILL' 1" }} />
  );

  return (
    <div id="landing-root">

      {/* ── NAV ── */}
      <nav className="fixed top-0 w-full z-50 bg-white/70 backdrop-blur-md shadow-florrie">
        <div className="flex justify-between items-center max-w-[1200px] mx-auto px-6 lg:px-10 py-4 w-full">
          <a href="/"><FloLogo /></a>
          <div className="hidden md:flex gap-8 items-center">
            <a className="text-on-surface-variant font-medium hover:text-primary transition-colors" href="#features">Features</a>
            <a className="text-on-surface-variant font-medium hover:text-primary transition-colors" href="#pricing">Pricing</a>
            <a className="text-on-surface-variant font-medium hover:text-primary transition-colors" href="#how-it-works">How it works</a>
          </div>
          <div className="flex items-center gap-4 lg:gap-6">
            <a className="hidden sm:block text-primary font-semibold hover:opacity-80 transition-opacity" href="/login">Sign in</a>
            <a className="bg-primary text-on-primary px-6 py-2.5 rounded-full font-semibold shadow-md hover:scale-95 transition-transform duration-200" href="#pricing">Start free trial</a>
          </div>
        </div>
      </nav>

      {/* ── HERO ── */}
      <section className="pt-32 pb-20 lg:pt-48 lg:pb-32 px-6 overflow-hidden">
        <div className="max-w-[1200px] mx-auto grid lg:grid-cols-[1.2fr_1fr] gap-16 items-center">
          <div className="space-y-8">
            <div className="inline-flex items-center gap-2 px-4 py-1.5 bg-primary-fixed text-on-primary-fixed-variant rounded-full text-sm font-semibold tracking-wide">
              <Icon name="auto_awesome" className="text-sm" style={{ fontVariationSettings: "'FILL' 1" }} />
              AI for beauty professionals
            </div>
            <h1 className="text-5xl lg:text-7xl font-serif italic leading-[1.1] text-on-surface">
              While you're doing lashes, Florrie's taking bookings.
            </h1>
            <p className="text-xl text-on-surface-variant max-w-lg">
              Five AI agents run behind the scenes. One handles WhatsApp bookings, one tracks your taxes, one keeps your records clean. They work around the clock so you don't have to.
            </p>
            {/* Agent status bar */}
            <div className="flex flex-wrap gap-3 pt-1">
              {[
                { color: '#34d399', label: 'Booking Agent',    cls: 'online-dot' },
                { color: '#fbbf24', label: 'Tax Agent',        cls: 'online-dot-2' },
                { color: '#2dd4bf', label: 'Compliance Agent', cls: 'online-dot-3' },
                { color: '#a78bfa', label: 'Follow-up Agent',  cls: 'online-dot-4' },
                { color: '#38bdf8', label: 'Insights Agent',   cls: 'online-dot-5' },
              ].map(({ color, label, cls }) => (
                <span key={label} className="inline-flex items-center gap-1.5 text-xs font-medium text-on-surface-variant bg-surface-container px-3 py-1.5 rounded-full">
                  <span className={`w-2 h-2 rounded-full ${cls}`} style={{ backgroundColor: color, display:'inline-block' }}></span>
                  {label}
                </span>
              ))}
            </div>
            <div className="flex flex-col sm:flex-row gap-4 pt-2">
              <a className="bg-gradient-to-r from-primary to-primary-container text-on-primary px-8 py-4 rounded-full font-bold text-lg text-center hover:shadow-lg transition-all" href="#pricing">Start your free trial</a>
              <a className="border border-outline-variant text-primary px-8 py-4 rounded-full font-bold text-lg text-center hover:bg-surface-container-low transition-colors" href="#how-it-works">See how it works</a>
            </div>
            <div className="flex items-center gap-3 py-2">
              <div className="inline-flex items-center gap-2 px-3 py-1.5 bg-primary-fixed rounded-full">
                <Icon name="rocket_launch" className="text-sm text-primary" style={{ fontVariationSettings: "'FILL' 1" }} />
                <span className="text-sm font-semibold text-on-primary-fixed-variant">Early access — be among the first</span>
              </div>
            </div>
          </div>

          {/* WhatsApp mockup */}
          <div className="relative">
            <div className="absolute -inset-10 bg-primary/5 rounded-full blur-3xl -z-10"></div>
            <div className="bg-white rounded-[3rem] p-4 shadow-florrie border border-white/20 max-w-[320px] mx-auto" style={{ transform: 'rotate(2deg)' }}>
              <div className="bg-stone-50 rounded-[2.5rem] overflow-hidden border border-stone-200">
                <div className="p-4 flex items-center gap-3 text-white" style={{ background: '#075e54' }}>
                  <Icon name="arrow_back" />
                  <div className="w-10 h-10 rounded-full flex items-center justify-center text-white font-bold text-base flex-shrink-0" style={{ background: 'linear-gradient(135deg,#f9a8d4,#ec4899)' }}>E</div>
                  <div>
                    <p className="text-sm font-bold leading-none">Emma</p>
                    <p className="text-[10px] opacity-80">Online</p>
                  </div>
                </div>
                <div className="p-4 space-y-4 min-h-[380px]" style={{ background: '#e5ddd5' }}>
                  <div className="msg-1 bg-white p-3 rounded-xl rounded-tl-none shadow-sm max-w-[80%] text-sm">
                    Hey! Do you have anything free Saturday afternoon? Two weeks time?
                  </div>
                  <div className="msg-2 p-3 rounded-xl rounded-tr-none shadow-sm ml-auto max-w-[80%] text-sm" style={{ background: '#dcf8c6' }}>
                    <p className="font-bold text-[10px] mb-1" style={{ color: '#92405e' }}>Florrie AI</p>
                    Hi Emma! I've got Saturday 12 April at 2pm or 4pm free for a full set. Want me to pencil you in? 💅
                  </div>
                  <div className="msg-3 bg-white p-3 rounded-xl rounded-tl-none shadow-sm max-w-[80%] text-sm">
                    2pm please!
                  </div>
                  <div className="msg-4 p-3 rounded-xl rounded-tr-none shadow-sm ml-auto max-w-[80%] text-sm" style={{ background: '#dcf8c6' }}>
                    <p className="font-bold text-[10px] mb-1" style={{ color: '#92405e' }}>Florrie AI</p>
                    Done! Booking confirmed for 2pm. I've sent your patch test reminder too. See you then! 🌸
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── CONTEXT BAR ── */}
      <section className="bg-white py-12 border-y border-surface-container overflow-hidden">
        <div className="max-w-[1200px] mx-auto px-6">
          <div className="flex flex-wrap justify-center md:justify-between items-center gap-8 text-on-surface-variant font-medium opacity-80">
            <div className="flex items-center gap-2"><Icon name="storefront" className="text-base text-secondary" />Built for independent beauty pros</div>
            <div className="hidden md:block w-px h-4 bg-outline-variant/30"></div>
            <div className="flex items-center gap-2"><Icon name="location_on" className="text-base text-secondary" />UK-based, UK tax rules built in</div>
            <div className="hidden md:block w-px h-4 bg-outline-variant/30"></div>
            <div className="flex items-center gap-2"><Icon name="lock" className="text-base text-secondary" />GDPR compliant from day one</div>
            <div className="hidden md:block w-px h-4 bg-outline-variant/30"></div>
            <div className="flex items-center gap-2"><Icon name="rocket_launch" className="text-base text-secondary" />Now in early access</div>
          </div>
        </div>
      </section>

      {/* ── PROBLEM ── */}
      <section className="py-24 px-6 bg-surface-container-low">
        <div className="max-w-[1000px] mx-auto text-center mb-16">
          <h2 className="text-4xl lg:text-5xl font-serif italic mb-6">Running a beauty business is a full-time job. Running it solo is two.</h2>
          <p className="text-lg text-on-surface-variant max-w-2xl mx-auto">
            You trained to do hair, nails, and lashes, not to spend your evenings replying to enquiries, chasing receipts and trying to remember who needs a patch test retake. Florrie handles the admin layer so you can get back to the work you're good at.
          </p>
        </div>
        <div className="max-w-[1200px] mx-auto grid md:grid-cols-2 gap-8">
          <div className="bg-white p-8 rounded-xl shadow-florrie space-y-4">
            <div className="flex items-center gap-3 text-error">
              <Icon name="block" /><h3 className="font-bold text-xl">The old way</h3>
            </div>
            <ul className="space-y-4">
              {['Miss enquiries when you\'re with a client','Forgot to log that cash payment for tax','No-shows with no warning','Patch test records on a paper notepad'].map(t => (
                <li key={t} className="flex gap-3 text-on-surface-variant"><Icon name="close" className="text-sm mt-1 text-error" />{t}</li>
              ))}
            </ul>
          </div>
          <div className="p-8 rounded-xl shadow-florrie space-y-4 border-l-4 border-primary" style={{ background: '#ffd9e2' }}>
            <div className="flex items-center gap-3 text-primary">
              <Icon name="check_circle" style={{ fontVariationSettings: "'FILL' 1" }} />
              <h3 className="font-bold text-xl">The Florrie way</h3>
            </div>
            <ul className="space-y-4">
              {['Booking Agent replies instantly, 24/7','Tax Agent logs every payment automatically','Follow-up Agent sends reminders and holds deposits','Compliance Agent keeps digital records up to date'].map(t => (
                <li key={t} className="flex gap-3" style={{ color: '#782b49' }}><Icon name="done" className="text-sm mt-1 text-primary" />{t}</li>
              ))}
            </ul>
          </div>
        </div>
      </section>

      {/* ── FEATURES ── */}
      <section className="py-24 px-6 bg-white" id="features">
        <div className="max-w-[1200px] mx-auto">
          <div className="mb-16">
            <span className="text-primary font-bold tracking-widest uppercase text-xs">What Florrie does</span>
            <h2 className="text-4xl lg:text-5xl font-serif italic mt-4">Everything you need in one place.</h2>
          </div>
          <div className="grid md:grid-cols-3 gap-8 lg:gap-12">
            {[
              { icon: 'chat_bubble',    title: 'AI Receptionist',       desc: 'Reads every WhatsApp message and replies in seconds, booking appointments, answering FAQs and handling reschedules while you work.' },
              { icon: 'calendar_month', title: 'Smart Booking',          desc: 'Clients book via your link or WhatsApp. Florrie checks availability, confirms appointments and sends reminders. No double-bookings, no gaps left open.' },
              { icon: 'payments',       title: 'Tax Dashboard',          desc: 'Built for UK sole traders. Log income, track expenses and see your HMRC estimate in real time. No spreadsheets, no boxes of receipts.' },
              { icon: 'verified_user',  title: 'Compliance Tracking',    desc: 'Patch test records, allergy histories and consultation forms in one place. Florrie flags when a patch test is due before an appointment.' },
              { icon: 'groups',         title: 'Client Profiles',        desc: 'Every client\'s booking history, notes, preferences and records in one card. Know exactly who\'s coming in before they walk through the door.' },
              { icon: 'send',           title: 'Automated Follow-ups',   desc: 'Thank-you messages, review requests and rebooking nudges go out after every appointment, without you touching your phone.' },
            ].map(({ icon, title, desc }) => (
              <div key={title} className="group">
                <div className="w-14 h-14 bg-primary-fixed rounded-full flex items-center justify-center mb-6 transition-transform group-hover:scale-110">
                  <Icon name={icon} className="text-primary text-3xl" />
                </div>
                <h3 className="font-bold text-xl mb-3">{title}</h3>
                <p className="text-on-surface-variant">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── AI TEAM ── */}
      <section id="ai-team" className="py-24 px-6 relative overflow-hidden" style={{ background: '#1A1A1A' }}>
        <div className="absolute inset-0 pointer-events-none" style={{ background: 'radial-gradient(ellipse 60% 50% at 50% 50%, rgba(199,107,138,0.12) 0%, transparent 70%)' }}></div>
        <div className="max-w-[1200px] mx-auto relative" style={{ zIndex: 10 }}>
          <div className="text-center mb-16">
            <span className="font-bold tracking-widest uppercase text-xs" style={{ color: '#C76B8A' }}>Your AI team</span>
            <h2 className="text-4xl lg:text-5xl font-serif italic mt-4 text-white">Five AI employees.<br/>Zero extra desks.</h2>
            <p className="mt-6 max-w-2xl mx-auto text-lg" style={{ color: 'rgba(255,255,255,0.6)' }}>
              Florrie isn't one AI. It's five specialised agents running in parallel, each handling a different part of your business, sharing context, handing off to each other when needed.
            </p>
          </div>

          {/* Desktop orbital */}
          <div className="relative mx-auto hidden lg:block" style={{ width: 520, height: 520 }}>
            <div className="absolute inset-0 rounded-full border border-dashed" style={{ borderColor: 'rgba(255,255,255,0.08)', animation: 'spin 80s linear infinite' }}></div>
            {/* SVG lines */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none" viewBox="0 0 520 520" style={{ zIndex: 0 }}>
              <line x1="260" y1="260" x2="260" y2="76"  stroke="#C76B8A" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.4" className="agent-line"/>
              <line x1="260" y1="260" x2="441" y2="201" stroke="#C9A96E" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.4" className="agent-line-2"/>
              <line x1="260" y1="260" x2="372" y2="414" stroke="#A78BFA" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.4" className="agent-line-3"/>
              <line x1="260" y1="260" x2="148" y2="414" stroke="#7BC8A4" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.4" className="agent-line-4"/>
              <line x1="260" y1="260" x2="79"  y2="201" stroke="#67B8C5" strokeWidth="1.5" strokeDasharray="5 5" opacity="0.4" className="agent-line-5"/>
            </svg>
            {/* Hub */}
            <div className="agent-hub absolute rounded-full flex items-center justify-center" style={{ top:'50%', left:'50%', transform:'translate(-50%,-50%)', width:96, height:96, background:'#C76B8A', zIndex:20 }}>
              <PetalIcon />
            </div>
            {/* Agents */}
            {[
              { cls:'agent-1', top:'13.5%', left:'50%',   color:'#C76B8A', icon:'chat_bubble',  label:'Booking Agent',    dot:'online-dot' },
              { cls:'agent-2', top:'38.7%', left:'84.8%', color:'#C9A96E', icon:'receipt_long', label:'Tax Agent',        dot:'online-dot-2' },
              { cls:'agent-3', top:'79.6%', left:'71.5%', color:'#A78BFA', icon:'send',         label:'Follow-up Agent',  dot:'online-dot-3' },
              { cls:'agent-4', top:'79.6%', left:'28.5%', color:'#7BC8A4', icon:'verified_user',label:'Compliance Agent', dot:'online-dot-4' },
              { cls:'agent-5', top:'38.7%', left:'15.2%', color:'#67B8C5', icon:'insights',     label:'Insights Agent',   dot:'online-dot-5' },
            ].map(({ cls, top, left, color, icon, label, dot }) => (
              <div key={label} className={`${cls} absolute text-center`} style={{ top, left, transform:'translate(-50%,-50%)', zIndex:10 }}>
                <div className="w-16 h-16 rounded-full flex items-center justify-center mx-auto mb-2" style={{ background:`${color}33`, border:`1px solid ${color}66` }}>
                  <Icon name={icon} className="text-2xl" style={{ color }} />
                </div>
                <p className="text-white text-xs font-semibold whitespace-nowrap">{label}</p>
                <div className="flex items-center justify-center gap-1 mt-1">
                  <span className={`w-1.5 h-1.5 rounded-full ${dot} inline-block`} style={{ background:'#34d399' }}></span>
                  <span className="text-[10px]" style={{ color: 'rgba(255,255,255,0.4)' }}>active</span>
                </div>
              </div>
            ))}
          </div>

          {/* Mobile grid */}
          <div className="grid grid-cols-2 gap-4 lg:hidden mt-8 max-w-sm mx-auto">
            {[
              { color:'#C76B8A', icon:'chat_bubble',  label:'Booking Agent',    sub:'WhatsApp bookings, 24/7',       span:false },
              { color:'#C9A96E', icon:'receipt_long', label:'Tax Agent',        sub:'Income, expenses, HMRC',        span:false },
              { color:'#7BC8A4', icon:'verified_user',label:'Compliance Agent', sub:'Patch tests, records',          span:false },
              { color:'#A78BFA', icon:'send',         label:'Follow-up Agent',  sub:'Reminders, rebooking',          span:false },
              { color:'#67B8C5', icon:'insights',     label:'Insights Agent',   sub:'Weekly revenue and performance summaries', span:true  },
            ].map(({ color, icon, label, sub, span }) => (
              <div key={label} className={`${span ? 'col-span-2' : ''} rounded-2xl p-5 text-center`} style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.1)' }}>
                <div className="w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3" style={{ background: `${color}33` }}>
                  <Icon name={icon} style={{ color }} />
                </div>
                <p className="text-white text-sm font-semibold">{label}</p>
                <p className="text-xs mt-1" style={{ color: 'rgba(255,255,255,0.4)' }}>{sub}</p>
              </div>
            ))}
          </div>

          <p className="text-center text-sm mt-12 max-w-lg mx-auto" style={{ color: 'rgba(255,255,255,0.4)' }}>
            All five agents are included in every Florrie plan. No add-ons, no tiers, no switching between tools.
          </p>
        </div>
      </section>

      {/* ── HOW IT WORKS ── */}
      <section className="py-24 px-6" id="how-it-works" style={{ background: '#F5EBF0' }}>
        <div className="max-w-[1200px] mx-auto">
          <h2 className="text-4xl lg:text-5xl font-serif italic mb-16 text-center">Up and running in 10 minutes.</h2>
          <div className="relative flex flex-col md:flex-row gap-12 items-start">
            <div className="hidden md:block absolute top-12 left-0 w-full h-0.5 bg-primary/20" style={{ zIndex: 0 }}>
              <div className="h-full bg-primary w-2/3"></div>
            </div>
            {[
              { n:'1', title:'Sign up',            desc:'Add your services, set your availability and tell Florrie how you like to work. Takes about 10 minutes. No card needed to start.', active:true },
              { n:'2', title:'Connect WhatsApp',   desc:'Link your business number. Florrie sits in the background — your clients message the same number they already have. Nothing changes for them.', active:true },
              { n:'3', title:'Let Florrie work',   desc:'From the moment it\'s live, your five AI agents handle replies, bookings and reminders. Check the dashboard when it suits you.', active:false },
            ].map(({ n, title, desc, active }) => (
              <div key={n} className="relative flex-1 space-y-6" style={{ zIndex: 10 }}>
                <div className={`w-12 h-12 rounded-full flex items-center justify-center font-bold text-xl border-4 ${active ? 'bg-primary text-on-primary border-[#F5EBF0]' : 'bg-surface-container text-on-surface-variant border-[#F5EBF0]'}`}>{n}</div>
                <h3 className="font-bold text-2xl">{title}</h3>
                <p className="text-on-surface-variant">{desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── WHAT WE HEARD ── */}
      <section className="py-24 px-6 bg-white overflow-hidden">
        <div className="max-w-[1200px] mx-auto">
          <div className="max-w-2xl mb-16">
            <span className="text-primary font-bold tracking-widest uppercase text-xs">Why we built this</span>
            <h2 className="text-4xl lg:text-5xl font-serif italic mt-4 mb-6">We talked to 40+ beauty pros before writing a line of code.</h2>
            <p className="text-lg text-on-surface-variant">The same things kept coming up. Florrie exists to fix them.</p>
          </div>
          <div className="grid md:grid-cols-2 gap-6">
            {[
              { quote: '"I\'m either with a client or dealing with the admin of having clients. There\'s no middle bit."', who: 'Nail tech, Bristol' },
              { quote: '"I missed an enquiry once because I was elbow-deep in a balayage. She booked somewhere else. That was an £80 appointment, gone."', who: 'Hair colourist, Edinburgh' },
              { quote: '"January terrifies me. I have a box of receipts and no idea what I actually owe HMRC."', who: 'Brow artist, Manchester' },
              { quote: '"My patch test records are on a notepad. I know it\'s not right but I haven\'t had the time to sort it."', who: 'Lash technician, Birmingham' },
            ].map(({ quote, who }) => (
              <div key={who} className="p-8 bg-surface-container-low rounded-xl" style={{ borderLeft: '3px solid #C76B8A' }}>
                <blockquote className="font-serif italic text-xl leading-relaxed text-on-surface mb-5">{quote}</blockquote>
                <p className="text-sm text-on-surface-variant font-medium">{who}</p>
              </div>
            ))}
          </div>
          <p className="mt-12 text-center text-on-surface-variant">If any of that sounds familiar, Florrie was built for you.</p>
        </div>
      </section>

      {/* ── PRICING ── */}
      <section className="py-24 px-6 bg-background" id="pricing">
        <div className="max-w-[1200px] mx-auto text-center">
          <span className="text-primary font-bold tracking-widest uppercase text-xs">Simple pricing</span>
          <h2 className="text-4xl lg:text-5xl font-serif italic mt-4 mb-4">One plan. No surprises.</h2>
          <p className="text-on-surface-variant mb-12">No contracts. Cancel any time.</p>
          <div className="inline-flex items-center p-1 bg-surface-container rounded-full mb-12">
            <button
              className={`px-6 py-2 rounded-full font-bold transition-all ${pricing === 'monthly' ? 'bg-white shadow-sm' : 'text-on-surface-variant'}`}
              onClick={() => setPricing('monthly')}
            >Monthly</button>
            <button
              className={`px-6 py-2 font-bold transition-all ${pricing === 'annual' ? 'bg-white shadow-sm rounded-full' : 'text-on-surface-variant'}`}
              onClick={() => setPricing('annual')}
            >Annual <span className="text-primary text-xs ml-1">(2 months free)</span></button>
          </div>
          <div className="max-w-md mx-auto bg-white rounded-[2rem] p-10 shadow-florrie relative" style={{ border: '2px solid rgba(146,64,94,0.1)' }}>
            <div className="absolute -top-4 left-1/2 -translate-x-1/2 bg-primary text-on-primary px-4 py-1 rounded-full text-xs font-bold tracking-widest uppercase">All 5 AI agents included</div>
            <h3 className="text-3xl font-serif italic mb-2">Florrie Pro</h3>
            <div className="flex items-center justify-center gap-1 mb-1">
              <span className="text-4xl font-bold">{price}</span>
              <span className="text-on-surface-variant">{period}</span>
            </div>
            <p className="text-on-surface-variant text-sm mb-8">{note}</p>
            <ul className="text-left space-y-4 mb-10">
              {['AI WhatsApp Receptionist','Smart booking & reminders','Tax & income dashboard','Compliance & client records','Unlimited clients & appointments','All 5 AI agents, always on'].map(f => (
                <li key={f} className="flex gap-3"><Icon name="check" className="text-primary" />{f}</li>
              ))}
            </ul>
            <a className="block w-full bg-primary text-on-primary py-4 rounded-xl font-bold text-lg hover:scale-105 transition-transform text-center" href="/login">Start your free 14-day trial</a>
            <p className="text-xs text-on-surface-variant mt-4">No card required to start.</p>
          </div>
          <p className="text-on-surface-variant text-sm mt-8">Running a small team? <a href="/login" className="text-primary font-semibold">Ask about our team plan →</a></p>
        </div>
      </section>

      {/* ── FINAL CTA ── */}
      <section className="py-24 px-6">
        <div className="max-w-[1200px] mx-auto rounded-[3rem] p-12 lg:p-24 text-center relative overflow-hidden shadow-2xl" style={{ background: '#31302f' }}>
          <div className="absolute top-0 right-0 w-96 h-96 blur-[100px]" style={{ background: 'rgba(146,64,94,0.2)', transform: 'translate(50%,-50%)' }}></div>
          <div className="absolute bottom-0 left-0 w-96 h-96 blur-[100px]" style={{ background: 'rgba(116,90,39,0.1)', transform: 'translate(-50%,50%)' }}></div>
          <div className="relative space-y-8" style={{ zIndex: 10 }}>
            <span className="font-bold tracking-widest uppercase text-xs" style={{ color: '#C76B8A' }}>Start today</span>
            <h2 className="text-4xl lg:text-6xl font-serif italic text-white leading-tight">Your next client is already<br/>typing a message.</h2>
            <p className="text-lg max-w-xl mx-auto" style={{ color: 'rgba(255,255,255,0.7)' }}>Make sure Florrie's there to answer it.</p>
            <div className="pt-4">
              <a className="inline-flex items-center gap-3 bg-primary text-on-primary px-10 py-5 rounded-full font-bold text-xl hover:bg-primary-container transition-all" href="/login">
                Start your free 14-day trial <Icon name="arrow_forward" />
              </a>
            </div>
            <p className="text-sm" style={{ color: 'rgba(255,255,255,0.4)' }}>No card required · Cancel any time · Set up in 10 minutes</p>
          </div>
        </div>
      </section>

      {/* ── FOOTER ── */}
      <footer className="bg-surface-container-low pt-20 pb-10">
        <div className="max-w-[1200px] mx-auto px-10 grid grid-cols-1 md:grid-cols-4 gap-12 mb-20">
          <div className="space-y-6">
            <a href="/"><FloLogoFooter /></a>
            <p className="text-on-surface-variant text-sm">AI for independent beauty professionals. Built in the UK.</p>
          </div>
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Product</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              {[['Features','#features'],['AI Team','#ai-team'],['Pricing','#pricing'],['How it works','#how-it-works']].map(([l,h]) => (
                <li key={l}><a className="hover:text-primary transition-colors" href={h}>{l}</a></li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Company</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              {[['About','#'],['Privacy policy','/privacy'],['Terms of service','/terms']].map(([l,h]) => (
                <li key={l}><a className="hover:text-primary transition-colors" href={h}>{l}</a></li>
              ))}
            </ul>
          </div>
          <div>
            <h4 className="font-bold mb-6 text-sm uppercase tracking-widest text-primary">Connect</h4>
            <ul className="space-y-4 text-sm text-on-surface-variant">
              {[['Instagram','https://instagram.com/getflorrie.ai'],['hello@florrie.ai','mailto:hello@florrie.ai']].map(([l,h]) => (
                <li key={l}><a className="hover:text-primary transition-colors" href={h}>{l}</a></li>
              ))}
            </ul>
          </div>
        </div>
        <div className="max-w-[1200px] mx-auto px-10 pt-10 flex flex-col md:flex-row justify-between items-center gap-6" style={{ borderTop: '1px solid rgba(134,114,119,0.2)' }}>
          <p className="text-sm text-on-surface-variant/70">© 2026 Florrie Ltd. All rights reserved.</p>
          <div className="flex gap-6">
            <a className="text-on-surface-variant hover:text-primary transition-colors" href="#"><Icon name="public" /></a>
            <a className="text-on-surface-variant hover:text-primary transition-colors" href="mailto:hello@florrie.ai"><Icon name="mail" /></a>
          </div>
        </div>
      </footer>

    </div>
  );
}
