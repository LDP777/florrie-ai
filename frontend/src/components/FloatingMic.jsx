import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

/**
 * FloatingMic, Day 5 of the 2026-05-28 refactor sprint.
 *
 * A small mauve mic button sitting bottom-right, above the 3-tab nav. Tap
 * once for a quick command (up to 12s). Long-press to keep recording
 * until release. Result drops into a transient confirmation card the
 * salon owner can accept, tweak, or dismiss.
 *
 * Hidden on the Inbox conversation view so it can't sit on top of the
 * reply composer, and hidden whenever a modal / bottom sheet / dialog is
 * open so it never floats over the price editor, daily brief, or the New
 * Appointment sheet.
 *
 * Two transports:
 *   1. Web Speech API where available (Chrome / Edge / desktop Safari 16+).
 *      Free, low-latency, no backend round-trip for transcription.
 *   2. MediaRecorder fallback for Safari iOS and Firefox. Records WebM/MP4,
 *      base64-encodes it, posts to /api/voice/command which uses Claude to
 *      transcribe and act.
 */

const SpeechRecognition = typeof window !== 'undefined'
  ? (window.SpeechRecognition || window.webkitSpeechRecognition)
  : null;

// Hard recording cap. Kept short so a tap can never leave the mic stuck
// "on" for half a minute if silence detection misfires (common in iOS
// WKWebView, where Web Speech is unavailable and we fall back to a recorder
// that never auto-stops).
const MAX_TAP_SECONDS = 12;
const LONG_PRESS_MS = 350;

// Inside the native app, "allow access" means the OS Settings app, not the browser.
const IS_NATIVE_APP = typeof window !== 'undefined' && !!window.Capacitor?.isNativePlatform?.();
const MIC_DENIED_MSG = IS_NATIVE_APP
  ? 'Mic access is off. Enable it in Settings, Florrie, Microphone.'
  : 'Mic blocked. Allow access and try again.';

// Hide the mic on routes where it would block the UI. The Inbox conversation
// view shows a reply composer at the bottom; the mic would sit on top of it.
function shouldHide(pathname) {
  if (!pathname) return false;
  // Inbox conversation: ?client=... is set as a search param, but pathname stays /inbox.
  // We check for the param at render time.
  if (pathname === '/voice') return true;
  if (pathname === '/login' || pathname === '/update-password') return true;
  if (pathname.startsWith('/book/') || pathname.startsWith('/form/')) return true;
  if (pathname === '/onboarding') return true;
  return false;
}

// True when an element looks like an open modal / bottom sheet / dialog that
// the mic must not float over. We catch two shapes:
//   1. Explicit a11y modals: role="dialog" or aria-modal="true".
//   2. Dimmed full-screen backdrops: a position:fixed element pinned to all
//      four edges (the rgba(0,0,0,0.4) overlays the calendar + suggestion
//      sheets use). These carry no role but are exactly what blocks Ellie.
// The mic's own result card is a role="dialog"; we tag it and skip it here so
// the mic never hides itself.
function isBlockingOverlay(el) {
  if (!el || el.nodeType !== 1) return false;
  if (el.closest?.('[data-floating-mic]')) return false; // our own result card
  const role = el.getAttribute?.('role');
  const ariaModal = el.getAttribute?.('aria-modal');
  if (role === 'dialog' || role === 'alertdialog' || ariaModal === 'true') return true;
  // Full-screen dimmed backdrop heuristic.
  try {
    const cs = window.getComputedStyle(el);
    if (cs.position !== 'fixed') return false;
    if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
    const pinnedTop = cs.top === '0px';
    const pinnedBottom = cs.bottom === '0px';
    const pinnedLeft = cs.left === '0px';
    const pinnedRight = cs.right === '0px';
    const fullInset = pinnedTop && pinnedBottom && pinnedLeft && pinnedRight;
    if (!fullInset) return false;
    // A real dimming backdrop has a translucent dark/colour wash. Plain
    // transparent full-screen wrappers (e.g. a layout root) are ignored.
    const bg = cs.backgroundColor || '';
    const m = bg.match(/rgba?\(([^)]+)\)/);
    if (!m) return false;
    const parts = m[1].split(',').map(s => parseFloat(s.trim()));
    const alpha = parts.length >= 4 ? parts[3] : 1;
    return alpha > 0.05;
  } catch {
    return false;
  }
}

function anyModalOpen() {
  if (typeof document === 'undefined') return false;
  const explicit = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"]');
  for (const el of explicit) {
    if (isBlockingOverlay(el)) return true;
  }
  // Scan direct-ish fixed backdrops on body. We keep this cheap by only
  // looking at body's element children and one level down (overlays mount
  // shallow), rather than the whole tree.
  const candidates = document.body ? document.body.children : [];
  for (const el of candidates) {
    if (isBlockingOverlay(el)) return true;
    for (const child of el.children || []) {
      if (isBlockingOverlay(child)) return true;
    }
  }
  return false;
}

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

export default function FloatingMic() {
  const location = useLocation();
  const navigate = useNavigate();

  const [recording, setRecording] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [interim, setInterim] = useState('');
  const [result, setResult] = useState(null); // { transcript, reply, actions }
  const [error, setError] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);

  const recognitionRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const longPressTimerRef = useRef(null);
  const isLongPressRef = useRef(false);
  const stoppedAutomaticallyRef = useRef(false);
  const stopTimeoutRef = useRef(null);

  // Hide on inbox thread view too. The conversation route is /inbox?client=…
  const isInboxThread = location.pathname === '/inbox' && /[?&]client=/.test(location.search || '');
  const hide = shouldHide(location.pathname) || isInboxThread;

  // Watch the DOM for any open modal / sheet / dialog and hide the mic while
  // one is up, so it never floats over the price editor, daily brief, or the
  // New Appointment sheet. A MutationObserver on body keeps this live as
  // sheets open and close. Cleaned up on unmount.
  useEffect(() => {
    if (typeof document === 'undefined') return undefined;
    let raf = 0;
    const check = () => {
      raf = 0;
      const open = anyModalOpen();
      setModalOpen(prev => (prev === open ? prev : open));
    };
    const schedule = () => {
      if (raf) return;
      raf = window.requestAnimationFrame(check);
    };
    schedule();
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['role', 'aria-modal', 'style', 'class'],
    });
    return () => {
      observer.disconnect();
      if (raf) window.cancelAnimationFrame(raf);
    };
  }, []);

  // Belt-and-braces: if a modal opens mid-recording, tear voice down so it
  // can't keep running invisibly behind the sheet.
  useEffect(() => {
    if (modalOpen) hardReset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modalOpen]);

  // Clean up timers + active streams when unmounting or hiding.
  useEffect(() => {
    return () => {
      hardReset();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fully tear down any in-flight recording and clear every transient state
  // flag. Safe to call from anywhere, any number of times.
  function hardReset() {
    if (longPressTimerRef.current) { clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; }
    if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
    isLongPressRef.current = false;
    stoppedAutomaticallyRef.current = true;
    stopRecognition();
    stopMediaRecorder();
    setRecording(false);
    setInterim('');
  }

  // ---- Web Speech API path (fast, transcription is free in-browser) ----
  function startRecognition({ continuous }) {
    if (!SpeechRecognition) return false;
    let rec;
    try {
      rec = new SpeechRecognition();
      rec.lang = 'en-GB';
      rec.interimResults = true;
      rec.continuous = continuous;
      rec.maxAlternatives = 1;
      stoppedAutomaticallyRef.current = false;
      rec.onstart = () => { setRecording(true); setInterim(''); setError(null); };
      rec.onresult = (event) => {
        let interimText = '';
        let finalText = '';
        for (let i = event.resultIndex; i < event.results.length; i++) {
          const t = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += t;
          else interimText += t;
        }
        if (finalText) {
          setInterim('');
          submitCommand(finalText.trim());
          stoppedAutomaticallyRef.current = true;
          try { rec.stop(); } catch {}
        } else {
          setInterim(interimText);
        }
      };
      rec.onerror = (event) => {
        if (event.error === 'no-speech') {
          setError("Didn't catch that. Try again.");
        } else if (event.error === 'not-allowed') {
          setError(MIC_DENIED_MSG);
        } else {
          logger.error('Speech recognition error:', event.error);
          setError("Mic didn't work. Try again.");
        }
        // Always clear any lingering recording / interim state.
        if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
        recognitionRef.current = null;
        setRecording(false);
        setInterim('');
      };
      rec.onend = () => {
        if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
        recognitionRef.current = null;
        setRecording(false);
        setInterim('');
      };
      recognitionRef.current = rec;
      rec.start();
      // Hard cap, even continuous mode stops after MAX_TAP_SECONDS.
      stopTimeoutRef.current = setTimeout(() => {
        stoppedAutomaticallyRef.current = true;
        stopRecognition();
        // If onend never fires (some WebViews), force the state clear.
        setRecording(false);
        setInterim('');
      }, MAX_TAP_SECONDS * 1000);
      return true;
    } catch (err) {
      // Engine threw (frequent in iOS WKWebView). Never leave a hanging
      // recording or interim state behind; signal failure so the caller can
      // fall back to MediaRecorder.
      logger.error('startRecognition failed:', err);
      try { rec?.stop(); } catch {}
      recognitionRef.current = null;
      setRecording(false);
      setInterim('');
      return false;
    }
  }

  function stopRecognition() {
    try { recognitionRef.current?.stop(); } catch {}
    try { recognitionRef.current?.abort?.(); } catch {}
    recognitionRef.current = null;
  }

  // ---- MediaRecorder fallback (Safari iOS) ----
  async function startMediaRecorder({ continuous }) {
    let stream;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Voice not supported on this browser. Type your command instead.');
        setRecording(false);
        setInterim('');
        return false;
      }
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : MediaRecorder.isTypeSupported('audio/mp4')
          ? 'audio/mp4'
          : '';
      const mr = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      audioChunksRef.current = [];
      mr.ondataavailable = (ev) => { if (ev.data?.size) audioChunksRef.current.push(ev.data); };
      mr.onstop = async () => {
        // Release the mic immediately.
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
        if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
        mediaRecorderRef.current = null;
        setRecording(false);
        setInterim('');
        const blob = new Blob(audioChunksRef.current, { type: mr.mimeType || 'audio/webm' });
        audioChunksRef.current = [];
        if (blob.size === 0) return;
        await submitAudio(blob, mr.mimeType || 'audio/webm');
      };
      mr.onerror = (ev) => {
        logger.error('MediaRecorder error:', ev);
        if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
        mediaRecorderRef.current = null;
        setRecording(false);
        setInterim('');
        setError("Mic didn't work. Try again.");
        try { stream.getTracks().forEach(t => t.stop()); } catch {}
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setRecording(true);
      setError(null);
      // Hard cap.
      stopTimeoutRef.current = setTimeout(() => {
        stoppedAutomaticallyRef.current = true;
        stopMediaRecorder();
      }, MAX_TAP_SECONDS * 1000);
      return true;
    } catch (err) {
      logger.error('startMediaRecorder failed:', err);
      try { stream?.getTracks().forEach(t => t.stop()); } catch {}
      mediaRecorderRef.current = null;
      setRecording(false);
      setInterim('');
      if (err?.name === 'NotAllowedError') {
        setError(MIC_DENIED_MSG);
      } else {
        setError('Voice not available. Type your command instead.');
      }
      return false;
    }
  }

  function stopMediaRecorder() {
    try {
      const mr = mediaRecorderRef.current;
      if (mr && mr.state !== 'inactive') mr.stop();
    } catch {}
    // onstop clears the ref + state; if it never fires, this still drops the ref.
    mediaRecorderRef.current = null;
  }

  async function submitAudio(blob, mimeType) {
    setProcessing(true);
    try {
      const base64 = await blobToBase64(blob);
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token || getToken();
      if (!token) {
        setError("You're not signed in. Sign in to use voice.");
        return;
      }
      const res = await fetch(`${API_BASE}/api/voice/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ audio_base64: base64, mime_type: mimeType }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Voice didn't go through. Try again.");
        return;
      }
      const data = await res.json();
      setResult({
        transcript: data.transcript || '',
        reply: data.reply || 'Done.',
        actions: data.actions || [],
      });
    } catch (err) {
      logger.error('submitAudio failed:', err);
      setError("Voice didn't go through. Try again.");
    } finally {
      setProcessing(false);
    }
  }

  async function submitCommand(text) {
    if (!text) return;
    setProcessing(true);
    try {
      const token = (await supabase?.auth.getSession())?.data?.session?.access_token || getToken();
      if (!token) {
        setError("You're not signed in. Sign in to use voice.");
        return;
      }
      const res = await fetch(`${API_BASE}/api/voice/command`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ text }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        setError(err.error || "Voice didn't go through. Try again.");
        return;
      }
      const data = await res.json();
      setResult({
        transcript: text,
        reply: data.reply || 'Done.',
        actions: data.actions || [],
      });
    } catch (err) {
      logger.error('submitCommand failed:', err);
      setError("Voice didn't go through. Try again.");
    } finally {
      setProcessing(false);
    }
  }

  // ---- Press handlers ----
  function beginPress(e) {
    e.preventDefault();
    if (processing) return;
    // A tap while already recording is a stop, handled in endPress. Don't arm
    // a fresh long-press in that case.
    if (recording) return;
    isLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      // Long-press: start continuous recording, release to stop.
      if (!startRecognition({ continuous: true })) {
        startMediaRecorder({ continuous: true });
      }
    }, LONG_PRESS_MS);
  }

  function endPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (isLongPressRef.current) {
      // Long-press release: stop and submit.
      stoppedAutomaticallyRef.current = true;
      if (recognitionRef.current) stopRecognition();
      else stopMediaRecorder();
      isLongPressRef.current = false;
      return;
    }
    // Tap while recording reliably stops and clears, whichever transport is live.
    if (recording || recognitionRef.current || mediaRecorderRef.current) {
      stoppedAutomaticallyRef.current = true;
      if (recognitionRef.current) stopRecognition();
      else stopMediaRecorder();
      // Force-clear in case the engine's onend / onstop never fires.
      if (stopTimeoutRef.current) { clearTimeout(stopTimeoutRef.current); stopTimeoutRef.current = null; }
      setRecording(false);
      setInterim('');
      return;
    }
    // Fresh tap: start a single short recording. Web Speech ends on its own
    // when it detects silence; MediaRecorder uses the hard cap.
    if (!startRecognition({ continuous: false })) {
      startMediaRecorder({ continuous: false });
    }
  }

  function cancelPress() {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }

  // ---- Result card actions ----
  function dismissResult() {
    setResult(null);
  }

  function continueWithFlorrie() {
    // Voice commands often need a follow-up (e.g. "move appointments" -> which
    // client, what time). Send them to the conversational /voice page rather
    // than a dead-end empty Inbox.
    setResult(null);
    navigate('/voice');
  }

  // Hide on excluded routes, and whenever a modal / sheet / dialog is open so
  // the mic never overlaps its content or buttons.
  if (hide || modalOpen) return null;

  // The mic sits bottom-right, hovering above the bottom nav. Bottom nav is
  // ~58px tall on iOS notch devices, plus safe-area. We push the mic above
  // it. The FloatingMore lives top-right, so they don't collide.
  return (
    <>
      {/* Live transcript preview */}
      {interim && recording && (
        <div style={S.interimBar}>
          <span style={S.interimText}>{interim}</span>
        </div>
      )}

      {/* Result card, ephemeral suggestion */}
      {result && !recording && !processing && (
        <div style={S.resultCard} data-floating-mic="result" role="dialog" aria-label="Voice result">
          <div style={S.resultTranscript}>"{result.transcript}"</div>
          <div style={S.resultReply}>{result.reply}</div>
          <div style={S.resultActions}>
            <button onClick={continueWithFlorrie} style={S.resultBtnPrimary}>Continue with Florrie</button>
            <button onClick={dismissResult} style={S.resultBtnGhost}>Dismiss</button>
          </div>
        </div>
      )}

      {/* Error toast */}
      {error && !recording && (
        <div style={S.errorBar} role="alert">
          <span style={S.errorText}>{error}</span>
          <button onClick={() => setError(null)} style={S.errorClose} aria-label="Dismiss">×</button>
        </div>
      )}

      {/* Mic button */}
      <button
        type="button"
        aria-label={recording ? 'Stop recording' : 'Tap to speak, hold to dictate'}
        onPointerDown={beginPress}
        onPointerUp={endPress}
        onPointerLeave={cancelPress}
        onPointerCancel={cancelPress}
        disabled={processing}
        style={{
          ...S.mic,
          background: recording
            ? 'linear-gradient(135deg, #D4605C 0%, #b04540 100%)'
            : processing
              ? 'linear-gradient(135deg, #b5879a 0%, #8a5d70 100%)'
              : 'linear-gradient(135deg, #C76B8A 0%, #92405e 100%)',
          boxShadow: recording
            ? '0 0 0 8px rgba(212,96,92,0.18), 0 4px 16px rgba(212,96,92,0.35)'
            : '0 4px 14px rgba(146,64,94,0.32)',
        }}
      >
        {recording && <span aria-hidden style={S.ripple} />}
        <span
          className="material-symbols-outlined"
          aria-hidden
          style={{
            fontSize: 26,
            color: '#fff',
            fontVariationSettings: "'FILL' 1, 'wght' 400",
            position: 'relative',
            zIndex: 1,
          }}
        >
          {processing ? 'hourglass_empty' : 'mic'}
        </span>
      </button>
    </>
  );
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      // strip "data:audio/webm;base64,"
      const base64 = String(dataUrl).split(',')[1] || '';
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Could not read audio'));
    reader.readAsDataURL(blob);
  });
}

const S = {
  mic: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 78px)',
    right: 16,
    width: 52,
    height: 52,
    borderRadius: 26,
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    WebkitTapHighlightColor: 'transparent',
    zIndex: 850,
    transition: 'transform 0.12s ease, box-shadow 0.2s ease, background 0.2s ease',
    touchAction: 'manipulation',
  },
  ripple: {
    position: 'absolute',
    inset: -8,
    borderRadius: '50%',
    border: '2px solid rgba(212,96,92,0.45)',
    animation: 'micRipple 1.4s ease-out infinite',
    pointerEvents: 'none',
    zIndex: 0,
  },
  interimBar: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 142px)',
    left: 16,
    right: 84,
    background: 'rgba(255, 217, 226, 0.96)',
    padding: '10px 14px',
    borderRadius: 14,
    boxShadow: '0 4px 14px rgba(146,64,94,0.18)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    fontStyle: 'italic',
    fontSize: 13,
    color: '#534247',
    zIndex: 845,
    maxHeight: 90,
    overflow: 'hidden',
  },
  interimText: { lineHeight: 1.4 },
  resultCard: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 142px)',
    left: 14,
    right: 14,
    background: '#fff',
    padding: '14px 16px',
    borderRadius: 16,
    boxShadow: '0 8px 28px rgba(146,64,94,0.22)',
    border: '1px solid rgba(146,64,94,0.1)',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    zIndex: 845,
    maxWidth: 460,
    margin: '0 auto',
    animation: 'micRise 0.22s cubic-bezier(0.16,1,0.3,1)',
  },
  resultTranscript: {
    fontSize: 12,
    color: '#92405e',
    fontStyle: 'italic',
    marginBottom: 6,
    lineHeight: 1.4,
  },
  resultReply: {
    fontSize: 14,
    color: '#1d1b19',
    fontWeight: 500,
    lineHeight: 1.45,
    marginBottom: 10,
  },
  resultActions: { display: 'flex', gap: 8, justifyContent: 'flex-end' },
  resultBtnPrimary: {
    padding: '7px 14px',
    borderRadius: 999,
    border: 'none',
    background: '#92405e',
    color: '#fff',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  resultBtnGhost: {
    padding: '7px 12px',
    borderRadius: 999,
    border: '1px solid #f0d2dd',
    background: '#fff',
    color: '#92405e',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  errorBar: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 0px) + 142px)',
    left: 16,
    right: 84,
    background: '#fff3f0',
    border: '1px solid rgba(212,96,92,0.25)',
    padding: '9px 12px',
    borderRadius: 12,
    boxShadow: '0 4px 12px rgba(212,96,92,0.12)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    fontSize: 12,
    color: '#9a3a36',
    zIndex: 845,
  },
  errorText: { flex: 1, lineHeight: 1.4 },
  errorClose: {
    background: 'none',
    border: 'none',
    color: '#9a3a36',
    fontSize: 18,
    cursor: 'pointer',
    padding: 0,
    lineHeight: 1,
  },
};

// Inject keyframes once.
if (typeof document !== 'undefined' && !document.getElementById('floating-mic-keyframes')) {
  const s = document.createElement('style');
  s.id = 'floating-mic-keyframes';
  s.textContent = `
    @keyframes micRipple {
      0%   { transform: scale(0.9);  opacity: 0.7; }
      100% { transform: scale(1.45); opacity: 0; }
    }
    @keyframes micRise {
      from { opacity: 0; transform: translateY(8px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}
