(() => {
  const form = document.getElementById('waitlist-form');
  if (!form) return;
  const button = form.querySelector('button[type="submit"]');
  const result = document.getElementById('waitlist-result');
  const endpoint = 'https://api.florrie.ai/api/waitlist';
  let captcha = null, widget = null, captchaToken = '', saved = false;
  const show = (message, error = false) => {
    result.textContent = message;
    result.dataset.state = error ? 'error' : 'success';
    result.setAttribute('role', error ? 'alert' : 'status');
  };
  async function request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, credentials: 'omit' });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'We could not confirm your signup. Please try again.');
      return data;
    } finally { clearTimeout(timeout); }
  }
  async function configure() {
    captcha = await request(endpoint + '/config');
    if (!captcha.required || widget !== null) return;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the security check. Please refresh and try again.'));
      document.head.appendChild(script);
    });
    widget = window.turnstile.render('#waitlist-captcha', {
      sitekey: captcha.siteKey, theme: 'dark', size: 'flexible',
      callback: token => { captchaToken = token; },
      'expired-callback': () => { captchaToken = ''; },
      'error-callback': () => { captchaToken = ''; show('Please retry the security check.', true); },
    });
  }
  button.disabled = true;
  configure().catch(() => { captcha = null; show('Could not connect. Your details have not been sent. Please try again.', true); })
    .finally(() => { button.disabled = false; });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (saved || !form.reportValidity()) return;
    button.disabled = true;
    button.textContent = 'Joining…';
    show('');
    try {
      if (!captcha) await configure();
      if (captcha.required && !captchaToken) throw new Error('Please complete the security check below.');
      const params = new URLSearchParams(location.search);
      const attribution = {};
      for (const key of ['utm_source', 'utm_medium', 'utm_campaign']) {
        if (params.get(key)) attribution[key] = params.get(key).slice(0, key === 'utm_campaign' ? 200 : 100);
      }
      const response = await request(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        email: form.elements.email.value.trim(), marketingConsent: form.elements.consent.checked,
        website: form.elements.website.value, attribution, 'cf-turnstile-response': captchaToken,
      }) });
      if (!response.success) throw new Error('We could not confirm your signup. Please try again.');
      saved = true;
      for (const input of form.querySelectorAll('input')) input.disabled = true;
      button.textContent = 'Thank you';
      const success = document.getElementById('waitlist-success');
      if (success) {
        document.getElementById('waitlist-success-email').textContent = form.elements.email.value.trim().toLowerCase();
        document.getElementById('waitlist-intro').hidden = true;
        form.hidden = true;
        result.hidden = true;
        success.hidden = false;
        document.getElementById('waitlist').classList.add('is-saved');
        success.focus({ preventScroll: true });
        success.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth', block: 'nearest' });
      } else {
        show('Thanks for joining. We’ll keep you posted about Florrie’s launch.');
        result.focus({ preventScroll: true });
      }
    } catch (error) {
      if (captcha?.required && widget === null) captcha = null;
      show(error.name === 'AbortError' || error instanceof TypeError
        ? 'We could not confirm your signup. Please try again; you won’t be added twice.'
        : error.message, true);
      if (widget !== null && window.turnstile) { window.turnstile.reset(widget); captchaToken = ''; }
    } finally {
      if (!saved) { button.disabled = false; button.textContent = 'Join the waitlist'; }
    }
  });
})();
