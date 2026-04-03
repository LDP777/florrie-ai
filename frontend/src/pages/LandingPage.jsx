import { useEffect, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

const LANDING_CSS = `
/* Landing page scoped reset */
.landing-root {
  position: fixed;
  inset: 0;
  z-index: 9990;
  overflow-y: auto;
  overflow-x: hidden;
  font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background-color: #fef8f4;
  color: #1d1b19;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  scroll-behavior: smooth;
}

.landing-root * {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

/* Grain texture overlay */
.landing-root::before {
  content: '';
  position: fixed;
  inset: 0;
  pointer-events: none;
  z-index: 9999;
  opacity: 0.03;
  mix-blend-mode: overlay;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 400 400' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' seed='2'/%3E%3C/filter%3E%3Crect width='400' height='400' filter='url(%23n)' opacity='0.03'/%3E%3C/svg%3E");
}

/* ===== TYPOGRAPHY ===== */
.landing-root h1, .landing-root h2, .landing-root h3, .landing-root h4, .landing-root h5, .landing-root h6 {
  font-weight: 400;
  line-height: 1.2;
}

.landing-root .display-italic {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-weight: 700;
  color: #92405e;
  letter-spacing: -0.02em;
}

.landing-root .section-heading {
  font-family: 'Noto Serif', serif;
  font-style: italic;
  font-weight: 400;
  color: #1d1b19;
}

.landing-root .label {
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #867277;
}

.landing-root .mono {
  font-family: 'DM Mono', monospace;
  font-weight: 400;
  font-size: 13px;
  color: #534247;
}

/* ===== LAYOUT ===== */
.landing-root .container {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 24px;
}

.landing-root .container-narrow {
  max-width: 600px;
  margin: 0 auto;
  padding: 0 24px;
}

/* ===== NAVIGATION ===== */
.landing-root .landing-nav {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 10000;
  backdrop-filter: blur(12px);
  background: rgba(254, 248, 244, 0.8);
  border-bottom: 1px solid rgba(216, 193, 198, 0.5);
  padding: 16px 24px;
}

.landing-root .nav-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.landing-root .logo {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-weight: 700;
  font-size: 20px;
  color: #92405e;
  letter-spacing: -0.02em;
}

.landing-root .nav-links {
  display: flex;
  align-items: center;
  gap: 20px;
}

.landing-root .nav-signin {
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 14px;
  font-weight: 500;
  color: #6b5a5f;
  text-decoration: none;
  transition: color 0.2s ease;
  cursor: pointer;
}

.landing-root .nav-signin:hover {
  color: #1d1b19;
}

.landing-root .nav-cta {
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 14px;
  font-weight: 600;
  color: #fff;
  background: #92405e;
  text-decoration: none;
  padding: 10px 22px;
  border-radius: 10px;
  transition: background 0.2s ease;
  cursor: pointer;
}

.landing-root .nav-cta:hover {
  background: #782b49;
}

/* ===== HERO ===== */
.landing-root .hero {
  padding-top: 160px;
  padding-bottom: 120px;
  text-align: center;
}

.landing-root .hero-label {
  margin-bottom: 24px;
}

.landing-root .hero h1 {
  font-size: clamp(40px, 6vw, 64px);
  margin-bottom: 24px;
  max-width: 100%;
}

.landing-root .hero-subtext {
  font-size: 18px;
  color: #534247;
  margin: 0 auto 48px;
  max-width: 480px;
  line-height: 1.7;
}

/* ===== CTA BUTTONS ===== */
.landing-root .hero-cta {
  display: inline-block;
  padding: 16px 48px;
  border: none;
  border-radius: 14px;
  background: linear-gradient(135deg, #c76b8a 0%, #92405e 100%);
  color: #ffffff;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(146, 64, 94, 0.25);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  margin-bottom: 12px;
}

.landing-root .hero-cta:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(146, 64, 94, 0.3);
}

.landing-root .hero-note {
  font-size: 13px;
  color: #867277;
  margin: 0 auto 16px;
}

.landing-root .final-cta-btn {
  display: inline-block;
  padding: 16px 48px;
  border: none;
  border-radius: 14px;
  background: linear-gradient(135deg, #c76b8a 0%, #92405e 100%);
  color: #ffffff;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 16px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(146, 64, 94, 0.25);
  transition: transform 0.2s ease, box-shadow 0.2s ease;
  margin-bottom: 16px;
}

.landing-root .final-cta-btn:hover {
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(146, 64, 94, 0.3);
}

.landing-root .form-note {
  font-size: 12px;
  color: #867277;
}

/* ===== DIVIDER ===== */
.landing-root .divider {
  height: 1px;
  background: rgba(216, 193, 198, 0.4);
  margin: 60px 0;
}

/* ===== SOCIAL PROOF ===== */
.landing-root .social-proof {
  padding: 48px 24px;
  text-align: center;
}

.landing-root .proof-row {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 32px;
  font-size: 13px;
  color: #867277;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  font-weight: 600;
}

.landing-root .proof-item {
  display: flex;
  align-items: center;
  gap: 12px;
}

.landing-root .proof-separator {
  width: 1px;
  height: 16px;
  background: rgba(216, 193, 198, 0.4);
}

@media (max-width: 640px) {
  .landing-root .proof-row {
    flex-direction: column;
    gap: 16px;
  }
  .landing-root .proof-separator {
    display: none;
  }
}

/* ===== HOW IT WORKS ===== */
.landing-root .how-it-works {
  background: #f3ede9;
  padding: 80px 24px;
}

.landing-root .how-it-works-header {
  text-align: center;
  margin-bottom: 60px;
}

.landing-root .how-it-works .label {
  margin-bottom: 16px;
  display: block;
}

.landing-root .how-it-works h2 {
  font-size: clamp(28px, 5vw, 48px);
  margin-bottom: 0;
}

.landing-root .timeline {
  max-width: 700px;
  margin: 0 auto;
}

.landing-root .timeline-item {
  display: flex;
  gap: 24px;
  margin-bottom: 48px;
  padding-bottom: 48px;
  border-bottom: 1px solid rgba(216, 193, 198, 0.3);
}

.landing-root .timeline-item:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.landing-root .timeline-time {
  flex-shrink: 0;
  width: 80px;
  text-align: right;
  color: #534247;
  font-weight: 600;
}

.landing-root .timeline-content {
  flex: 1;
  color: #534247;
  line-height: 1.7;
}

/* ===== PRICING ===== */
.landing-root .pricing-section {
  padding: 80px 24px;
}

.landing-root .pricing-header {
  text-align: center;
  margin-bottom: 60px;
}

.landing-root .pricing-header .label {
  margin-bottom: 16px;
  display: block;
}

.landing-root .pricing-header h2 {
  font-size: clamp(28px, 5vw, 48px);
  margin-bottom: 16px;
}

.landing-root .pricing-subtext {
  font-size: 16px;
  color: #534247;
  max-width: 500px;
  margin: 0 auto;
}

.landing-root .toggle-container {
  display: flex;
  justify-content: center;
  gap: 8px;
  margin-bottom: 48px;
  background: #f3ede9;
  border-radius: 20px;
  padding: 4px;
  width: fit-content;
  margin-left: auto;
  margin-right: auto;
}

.landing-root .toggle-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 16px;
  background: transparent;
  color: #534247;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  font-family: 'Plus Jakarta Sans', sans-serif;
}

.landing-root .toggle-btn.active {
  background: #ffffff;
  color: #92405e;
  box-shadow: 0 1px 4px rgba(146, 64, 94, 0.08);
}

.landing-root .pricing-cards {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 24px;
  max-width: 1100px;
  margin: 0 auto;
}

.landing-root .pricing-card {
  background: #ffffff;
  border: 1px solid #d8c1c6;
  border-radius: 16px;
  padding: 32px 24px;
  display: flex;
  flex-direction: column;
  transition: all 0.3s ease;
}

.landing-root .pricing-card:hover {
  box-shadow: 0 8px 24px rgba(146, 64, 94, 0.08);
  border-color: #92405e;
}

.landing-root .pricing-card.popular {
  border: 2px solid #92405e;
  box-shadow: 0 8px 24px rgba(146, 64, 94, 0.12);
  transform: scale(1.02);
}

.landing-root .pricing-popular-tag {
  display: inline-block;
  background: #92405e;
  color: #ffffff;
  padding: 4px 12px;
  border-radius: 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  margin-bottom: 16px;
  width: fit-content;
}

.landing-root .pricing-tier {
  font-size: 16px;
  font-weight: 600;
  color: #1d1b19;
  margin-bottom: 8px;
}

.landing-root .pricing-price {
  font-size: 32px;
  font-weight: 700;
  color: #92405e;
  margin-bottom: 4px;
}

.landing-root .pricing-price-period {
  font-size: 12px;
  color: #867277;
  margin-bottom: 24px;
}

.landing-root .pricing-description {
  font-size: 13px;
  color: #534247;
  margin-bottom: 24px;
  min-height: 40px;
}

.landing-root .pricing-features {
  flex: 1;
  margin-bottom: 24px;
}

.landing-root .pricing-feature {
  font-size: 13px;
  color: #534247;
  line-height: 1.8;
  padding: 8px 0;
  border-bottom: 1px solid rgba(216, 193, 198, 0.3);
}

.landing-root .pricing-feature:last-child {
  border-bottom: none;
}

.landing-root .pricing-cta-btn {
  display: inline-block;
  padding: 14px 40px;
  border: none;
  border-radius: 12px;
  background: linear-gradient(135deg, #c76b8a 0%, #92405e 100%);
  color: #fff;
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 15px;
  font-weight: 600;
  text-decoration: none;
  cursor: pointer;
  box-shadow: 0 2px 8px rgba(146, 64, 94, 0.25);
  transition: transform 0.2s ease;
}

.landing-root .pricing-cta-btn:hover {
  transform: translateY(-2px);
}

/* ===== TESTIMONIAL ===== */
.landing-root .testimonial-section {
  padding: 100px 24px;
  text-align: center;
  background: #fef8f4;
}

.landing-root .testimonial-quote {
  position: relative;
  margin-bottom: 32px;
}

.landing-root .quote-mark {
  font-family: 'Playfair Display', serif;
  font-size: 72px;
  color: #92405e;
  opacity: 0.3;
  line-height: 0.5;
  margin-bottom: 16px;
}

.landing-root .testimonial-text {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-weight: 700;
  font-size: clamp(20px, 4vw, 28px);
  color: #1d1b19;
  max-width: 700px;
  margin: 0 auto 24px;
  letter-spacing: -0.01em;
}

.landing-root .testimonial-attribution {
  font-size: 13px;
  color: #867277;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* ===== FINAL CTA ===== */
.landing-root .final-cta {
  background: linear-gradient(135deg, #c76b8a 0%, #92405e 100%);
  padding: 80px 24px;
  text-align: center;
  color: #ffffff;
}

.landing-root .final-cta h2 {
  font-size: clamp(32px, 5vw, 48px);
  margin-bottom: 16px;
}

.landing-root .final-cta-subtext {
  font-size: 16px;
  margin-bottom: 40px;
  opacity: 0.95;
  max-width: 500px;
  margin-left: auto;
  margin-right: auto;
}

.landing-root .final-cta .final-cta-btn {
  background: #ffffff;
  color: #92405e;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.15);
}

.landing-root .final-cta .final-cta-btn:hover {
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.2);
}

.landing-root .final-cta .form-note {
  color: rgba(255, 255, 255, 0.8);
}

.landing-root .final-cta .form-note a {
  color: rgba(255, 255, 255, 0.95);
}

/* ===== FOOTER ===== */
.landing-root .landing-footer {
  background: #f3ede9;
  padding: 40px 24px;
  text-align: center;
  border-top: 1px solid #d8c1c6;
}

.landing-root .footer-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 24px;
  flex-wrap: wrap;
  font-size: 13px;
  color: #867277;
}

.landing-root .footer-logo {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-weight: 700;
  color: #92405e;
  font-size: 14px;
}

.landing-root .footer-links {
  display: flex;
  gap: 24px;
}

.landing-root .footer-links a {
  color: #867277;
  text-decoration: none;
  transition: color 0.2s ease;
}

.landing-root .footer-links a:hover {
  color: #92405e;
}

/* ===== PROBLEM SECTION ===== */
.landing-root .problem-section {
  padding: 100px 24px 80px;
  background: #f3ede9;
}

.landing-root .problem-header {
  text-align: center;
  margin-bottom: 60px;
}

.landing-root .problem-header .label {
  margin-bottom: 16px;
  display: block;
}

.landing-root .problem-header h2 {
  font-size: clamp(26px, 4vw, 40px);
  max-width: 600px;
  margin: 0 auto;
}

.landing-root .problem-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  max-width: 900px;
  margin: 0 auto;
}

.landing-root .problem-card {
  padding: 28px;
  background: #fef8f4;
  border-radius: 16px;
  border: 1px solid rgba(216, 193, 198, 0.4);
}

.landing-root .problem-card-time {
  font-family: 'DM Mono', monospace;
  font-size: 12px;
  color: #92405e;
  font-weight: 500;
  margin-bottom: 10px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

.landing-root .problem-card p {
  font-size: 15px;
  color: #534247;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .landing-root .problem-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
  .landing-root .problem-card {
    padding: 20px;
  }
}

/* ===== MEET FLORRIE ===== */
.landing-root .meet-section {
  padding: 100px 24px;
  text-align: center;
}

.landing-root .meet-header {
  margin-bottom: 40px;
}

.landing-root .meet-header .label {
  margin-bottom: 16px;
  display: block;
}

.landing-root .meet-header h2 {
  font-size: clamp(28px, 5vw, 44px);
  margin-bottom: 0;
}

.landing-root .meet-body {
  max-width: 620px;
  margin: 0 auto;
}

.landing-root .meet-body p {
  font-size: 16px;
  color: #534247;
  line-height: 1.8;
  margin-bottom: 20px;
  text-align: left;
}

.landing-root .meet-body p:last-child {
  margin-bottom: 0;
}

.landing-root .meet-detail {
  margin-top: 40px;
  padding: 24px 28px;
  background: #f3ede9;
  border-radius: 14px;
  font-size: 14px;
  color: #534247;
  line-height: 1.7;
  max-width: 500px;
  margin-left: auto;
  margin-right: auto;
  text-align: left;
  border-left: 3px solid #92405e;
}

/* ===== INLINE TESTIMONIAL ===== */
.landing-root .inline-testimonial {
  padding: 60px 24px;
  text-align: center;
  background: #fef8f4;
}

.landing-root .inline-testimonial blockquote {
  font-family: 'Playfair Display', serif;
  font-style: italic;
  font-weight: 700;
  font-size: clamp(18px, 3vw, 24px);
  color: #1d1b19;
  max-width: 600px;
  margin: 0 auto 16px;
  letter-spacing: -0.01em;
  line-height: 1.4;
}

.landing-root .inline-testimonial cite {
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-style: normal;
  font-size: 12px;
  color: #867277;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
}

/* ===== UK BEAUTY SECTION ===== */
.landing-root .uk-section {
  padding: 100px 24px;
  background: #fef8f4;
}

.landing-root .uk-header {
  text-align: center;
  margin-bottom: 60px;
}

.landing-root .uk-header .label {
  margin-bottom: 16px;
  display: block;
}

.landing-root .uk-header h2 {
  font-size: clamp(26px, 4.5vw, 42px);
  margin-bottom: 16px;
}

.landing-root .uk-header p {
  font-size: 16px;
  color: #534247;
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.7;
}

.landing-root .uk-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 32px;
  max-width: 900px;
  margin: 0 auto;
}

.landing-root .uk-card {
  padding: 28px;
  background: #ffffff;
  border-radius: 16px;
  border: 1px solid #d8c1c6;
  transition: box-shadow 0.3s ease;
}

.landing-root .uk-card:hover {
  box-shadow: 0 8px 24px rgba(146, 64, 94, 0.06);
}

.landing-root .uk-card h3 {
  font-family: 'Plus Jakarta Sans', sans-serif;
  font-size: 16px;
  font-weight: 700;
  color: #1d1b19;
  margin-bottom: 10px;
}

.landing-root .uk-card p {
  font-size: 14px;
  color: #534247;
  line-height: 1.7;
}

@media (max-width: 640px) {
  .landing-root .uk-grid {
    grid-template-columns: 1fr;
    gap: 20px;
  }
}

/* ===== PITCH SECTION ===== */
.landing-root .pitch-section {
  padding: 120px 24px;
}

.landing-root .pitch-block {
  text-align: center;
  margin-bottom: 80px;
}

.landing-root .pitch-block:last-child {
  margin-bottom: 0;
}

.landing-root .pitch-headline {
  font-size: 28px;
  margin-bottom: 16px;
  color: #1d1b19;
}

.landing-root .pitch-text {
  font-size: 16px;
  color: #534247;
  max-width: 500px;
  margin: 0 auto;
  line-height: 1.7;
}

/* ===== RESPONSIVE ===== */
@media (max-width: 768px) {
  .landing-root .landing-nav {
    padding: 12px 16px;
  }
  .landing-root .nav-content {
    padding: 0;
  }
  .landing-root .logo {
    font-size: 16px;
  }
  .landing-root .nav-cta {
    font-size: 12px;
    padding: 8px 16px;
  }
  .landing-root .nav-signin {
    font-size: 12px;
  }
  .landing-root .nav-links {
    gap: 12px;
  }
  .landing-root .hero {
    padding-top: 100px;
    padding-bottom: 80px;
  }
  .landing-root .hero h1 {
    margin-bottom: 20px;
  }
  .landing-root .hero-subtext {
    font-size: 16px;
    margin-bottom: 40px;
  }
  .landing-root .pitch-section {
    padding: 80px 24px;
  }
  .landing-root .pitch-block {
    margin-bottom: 60px;
  }
  .landing-root .pitch-headline {
    font-size: 24px;
  }
  .landing-root .pitch-text {
    font-size: 14px;
  }
  .landing-root .social-proof {
    padding: 40px 16px;
  }
  .landing-root .problem-section {
    padding: 60px 16px;
  }
  .landing-root .meet-section {
    padding: 60px 16px;
  }
  .landing-root .uk-section {
    padding: 60px 16px;
  }
  .landing-root .inline-testimonial {
    padding: 40px 16px;
  }
  .landing-root .inline-testimonial blockquote {
    font-size: 18px;
  }
  .landing-root .meet-detail {
    padding: 18px 20px;
    font-size: 13px;
  }
  .landing-root .how-it-works {
    padding: 60px 16px;
  }
  .landing-root .how-it-works-header {
    margin-bottom: 40px;
  }
  .landing-root .timeline-item {
    flex-direction: column;
    gap: 12px;
  }
  .landing-root .timeline-time {
    width: auto;
    text-align: left;
  }
  .landing-root .pricing-section {
    padding: 60px 16px;
  }
  .landing-root .pricing-card {
    padding: 24px 16px;
  }
  .landing-root .pricing-card.popular {
    transform: scale(1);
  }
  .landing-root .testimonial-section {
    padding: 60px 16px;
  }
  .landing-root .testimonial-text {
    font-size: 20px;
  }
  .landing-root .final-cta {
    padding: 60px 16px;
  }
  .landing-root .final-cta h2 {
    font-size: 28px;
  }
  .landing-root .footer-content {
    flex-direction: column;
    gap: 16px;
  }
}

@media (max-width: 480px) {
  .landing-root .hero {
    padding-top: 80px;
    padding-bottom: 60px;
  }
  .landing-root .hero h1 {
    font-size: 32px;
  }
  .landing-root .hero-subtext {
    font-size: 14px;
  }
  .landing-root .pitch-headline {
    font-size: 20px;
  }
  .landing-root .pitch-text {
    font-size: 13px;
  }
  .landing-root .pricing-header h2 {
    font-size: 24px;
  }
  .landing-root .testimonial-text {
    font-size: 18px;
  }
  .landing-root .final-cta h2 {
    font-size: 24px;
  }
  .landing-root .quote-mark {
    font-size: 48px;
  }
}
`;

export default function LandingPage() {
  const navigate = useNavigate();
  const rootRef = useRef(null);

  const goToLogin = useCallback((e) => {
    if (e) e.preventDefault();
    navigate('/login');
  }, [navigate]);

  // Inject scoped CSS + set up pricing toggle
  useEffect(() => {
    // Inject CSS
    const style = document.createElement('style');
    style.id = 'landing-page-css';
    style.textContent = LANDING_CSS;
    document.head.appendChild(style);

    // Set page title
    const prevTitle = document.title;
    document.title = 'florrie — AI for your salon';

    // Hide body overflow while landing is shown (it has its own scroll)
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    return () => {
      style.remove();
      document.title = prevTitle;
      document.body.style.overflow = prevOverflow;
    };
  }, []);

  // Intercept all internal link clicks
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const handleClick = (e) => {
      const link = e.target.closest('a[href="/login"]');
      if (link) {
        e.preventDefault();
        navigate('/login');
      }
    };

    root.addEventListener('click', handleClick);
    return () => root.removeEventListener('click', handleClick);
  }, [navigate]);

  // Pricing toggle logic
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const toggleBtns = root.querySelectorAll('.toggle-btn');
    const handleToggle = (e) => {
      const btn = e.currentTarget;
      toggleBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const isAnnual = btn.dataset.period === 'annual';
      root.querySelectorAll('.price-amount').forEach(el => {
        el.textContent = isAnnual ? el.dataset.annual : el.dataset.monthly;
      });
      root.querySelectorAll('.monthly-text').forEach(el => {
        el.textContent = isAnnual ? '/year' : '/month';
      });
    };

    toggleBtns.forEach(btn => btn.addEventListener('click', handleToggle));
    return () => toggleBtns.forEach(btn => btn.removeEventListener('click', handleToggle));
  }, []);

  return (
    <div className="landing-root" ref={rootRef}>
      {/* Navigation */}
      <div className="landing-nav">
        <div className="nav-content">
          <div className="logo">florrie</div>
          <div className="nav-links">
            <a href="/login" className="nav-signin" onClick={goToLogin}>Sign in</a>
            <a href="/login" className="nav-cta" onClick={goToLogin}>Try for free</a>
          </div>
        </div>
      </div>

      {/* Hero */}
      <section className="hero">
        <div className="container-narrow">
          <div className="label">For beauticians</div>
          <h1 className="display-italic">The AI that runs your salon while you run your business</h1>
          <p className="hero-subtext">Florrie handles your bookings, replies to clients in your voice, tracks your tax, and keeps you compliant. You focus on the chair.</p>
          <a href="/login" className="hero-cta" onClick={goToLogin}>Try for free</a>
          <p className="hero-note">14-day free trial. No card required.</p>
        </div>
      </section>

      {/* Pitch */}
      <section className="pitch-section">
        <div className="pitch-block">
          <h2 className="section-heading pitch-headline">She talks like you</h2>
          <p className="pitch-text">Florrie learns your tone from every correction. She picks up your abbreviations, your sign-off style, the way you greet regulars vs new enquiries. After a week, clients can't tell the difference.</p>
        </div>
        <div className="pitch-block">
          <h2 className="section-heading pitch-headline">Your tax, sorted</h2>
          <p className="pitch-text">Snap a receipt, Florrie files it. Every payment tracked against HMRC categories in real time. When self-assessment comes around, you export a clean summary instead of panicking over a carrier bag of paper.</p>
        </div>
        <div className="pitch-block">
          <h2 className="section-heading pitch-headline">Compliance on autopilot</h2>
          <p className="pitch-text">Patch test tracking, consultation forms, aftercare messages. Florrie knows which clients need what, and sends reminders before their appointment. Not after something goes wrong.</p>
        </div>
      </section>

      {/* Social Proof */}
      <div className="divider" />
      <section className="social-proof">
        <div className="proof-row">
          <div className="proof-item">Built for UK salons</div>
          <div className="proof-separator" />
          <div className="proof-item">Built for UK beauticians</div>
          <div className="proof-separator" />
          <div className="proof-item">7 AI features at launch</div>
        </div>
      </section>
      <div className="divider" />

      {/* The Problem */}
      <section className="problem-section">
        <div className="problem-header">
          <span className="label">Sound familiar?</span>
          <h2 className="display-italic">You didn't start a beauty business to answer WhatsApp at midnight</h2>
        </div>
        <div className="problem-grid">
          <div className="problem-card">
            <div className="problem-card-time">The 11pm message</div>
            <p>"Can I move my Thursday to Friday?" You're half asleep. You open your diary, scroll through next week, find a gap, type a reply. Then you lie there for twenty minutes because your brain won't switch off.</p>
          </div>
          <div className="problem-card">
            <div className="problem-card-time">The shoebox</div>
            <p>Receipts from Sally Beauty. Amazon. Your wax supplier. That Uber to the training course. They're in a drawer, a carrier bag, your coat pocket. You'll sort them in January. You said that last January too.</p>
          </div>
          <div className="problem-card">
            <div className="problem-card-time">The no-show</div>
            <p>She booked three weeks ago. No confirmation sent, no patch test done. You find out at 9am when the chair's empty and your morning's got a hole in it. You scroll back through your messages to check. Nothing.</p>
          </div>
          <div className="problem-card">
            <div className="problem-card-time">The Sunday night</div>
            <p>You sit on the sofa with your phone and a notebook. Moving appointments around. Writing next week's Instagram caption. Checking who needs reminders. Two hours gone. You haven't even thought about what you're actually doing with your week.</p>
          </div>
        </div>
      </section>

      {/* Meet Florrie */}
      <section className="meet-section">
        <div className="meet-header">
          <span className="label">Who she is</span>
          <h2 className="display-italic">She's the colleague you always needed</h2>
        </div>
        <div className="meet-body">
          <p>Florrie reads your WhatsApp, Instagram DMs, texts, and emails. She replies in your voice. Not a chatbot voice. Yours. She writes "hiya lovely" because that's what you write. She knows your cancellation policy word for word. She knows you don't take bookings before 10 on Mondays.</p>
          <p>She gets better every time you correct her. Changed a reply she sent? She remembers why and adjusts next time. After a week, your regulars won't notice the difference. New clients will think you reply fast.</p>
          <p>She books appointments, sends confirmations, chases no-shows, fills last-minute gaps from your waitlist, and nudges clients to rebook when they're due. All while you're with a client, or at the gym, or asleep.</p>
          <div className="meet-detail">
            When she's not sure about something, she flags it and steps aside. Complaints, clinical questions, anything sensitive. You decide. She learns from that too.
          </div>
        </div>
      </section>

      {/* Inline Testimonial */}
      <section className="inline-testimonial">
        <blockquote>"I tested her by not replying to anything for a whole Saturday. Checked my phone at 6pm — four new bookings, two reschedules, all handled. I nearly cried."</blockquote>
        <cite>Jade T. — Lash tech, Birmingham</cite>
      </section>

      {/* How It Works */}
      <section className="how-it-works">
        <div className="how-it-works-header">
          <div className="label">How it works</div>
          <h2 className="display-italic">Your morning. Reimagined.</h2>
        </div>
        <div className="timeline">
          <div className="timeline-item">
            <div className="timeline-time mono">7:30am</div>
            <div className="timeline-content">You're still in bed. Florrie's been up since six. Three WhatsApp messages came in overnight: a new booking request, a reschedule, and someone asking about lash lift prices. All handled. Two confirmations sent. One price list shared with a link to book.</div>
          </div>
          <div className="timeline-item">
            <div className="timeline-time mono">9:15am</div>
            <div className="timeline-content">Your first client sits down. Your phone buzzes. Cancellation for 2pm. Florrie's already texted the next three people on your waitlist. By the time you look up from the brow, the slot's filled. You didn't touch your phone once.</div>
          </div>
          <div className="timeline-item">
            <div className="timeline-time mono">12:00pm</div>
            <div className="timeline-content">Lunch. You snap a photo of a receipt from Sally Beauty. £34 for wax supplies. Florrie scans it, files it under HMRC consumables, and your running tax estimate ticks up. No spreadsheet. No shoebox. Thirty seconds and it's done.</div>
          </div>
          <div className="timeline-item">
            <div className="timeline-time mono">2:30pm</div>
            <div className="timeline-content">A new enquiry lands on Instagram. "Do you do brow lamination? How much?" Florrie replies with your prices, your availability next week, and a booking link. The client books for Thursday. You never saw the message.</div>
          </div>
          <div className="timeline-item">
            <div className="timeline-time mono">4:00pm</div>
            <div className="timeline-content">Florrie flags something: Emma Collins has a tint booked for Friday, but her last patch test was eight weeks ago. Needs a fresh one. Florrie's already sent Emma a reminder with instructions and a link to confirm.</div>
          </div>
          <div className="timeline-item">
            <div className="timeline-time mono">6:30pm</div>
            <div className="timeline-content">Your last client leaves. Florrie's sent three aftercare messages, nudged two people to rebook, and drafted tomorrow's Instagram caption for you to approve. You close the salon door. The admin is already done.</div>
          </div>
        </div>
      </section>

      {/* Built for UK Beauty */}
      <section className="uk-section">
        <div className="uk-header">
          <span className="label">Built for your world</span>
          <h2 className="display-italic">We know HMRC. We know patch tests. We know your January.</h2>
          <p>Florrie was built for UK beauticians from day one. Not adapted from a generic booking tool. Built.</p>
        </div>
        <div className="uk-grid">
          <div className="uk-card">
            <h3>Self-assessment, sorted</h3>
            <p>Florrie tracks your income and expenses against HMRC categories in real time. When January comes, you export a clean summary. Your accountant gets a spreadsheet instead of a carrier bag.</p>
          </div>
          <div className="uk-card">
            <h3>Making Tax Digital ready</h3>
            <p>MTD is coming for everyone. Florrie keeps your records in the format HMRC expects, so you're not scrambling to digitise a year of paper when the deadline hits.</p>
          </div>
          <div className="uk-card">
            <h3>Patch test tracking</h3>
            <p>Regulations say you need them. Florrie remembers when each client's patch test expires and sends reminders before their appointment. Not after something goes wrong and you're checking your records.</p>
          </div>
          <div className="uk-card">
            <h3>Aftercare on record</h3>
            <p>Every treatment gets the right aftercare message, sent automatically. If a client ever disputes what they were told, you have a timestamped record. Protection for you and your business.</p>
          </div>
        </div>
      </section>

      {/* Inline Testimonial 2 */}
      <section className="inline-testimonial">
        <blockquote>"The tax tracking sold me. I paid my accountant £400 last year just to sort my receipts into categories. Florrie does it the moment I take a photo."</blockquote>
        <cite>Priya K. — Nail artist, Leeds</cite>
      </section>

      {/* Pricing */}
      <section className="pricing-section">
        <div className="pricing-header">
          <div className="label">Pricing</div>
          <h2 className="display-italic">One plan. Everything included.</h2>
          <p className="pricing-subtext">14-day free trial. No card required. Cancel anytime.</p>
        </div>

        <div className="toggle-container">
          <button className="toggle-btn active" data-period="monthly">Monthly</button>
          <button className="toggle-btn" data-period="annual">Annual<span style={{ fontSize: '10px', marginLeft: '4px' }}>Save £58</span></button>
        </div>

        <div className="pricing-cards" style={{ maxWidth: '480px' }}>
          <div className="pricing-card popular">
            <div className="pricing-popular-tag">Everything you need</div>
            <div className="pricing-tier">Florrie</div>
            <div className="pricing-price"><span className="price-amount" data-monthly="£29" data-annual="£290">£29</span></div>
            <div className="pricing-price-period monthly-text">/month</div>
            <div className="pricing-description">For solo beauticians and small salons</div>
            <div className="pricing-features">
              <div className="pricing-feature">Unlimited clients</div>
              <div className="pricing-feature">AI receptionist (WhatsApp, SMS, Instagram)</div>
              <div className="pricing-feature">Smart scheduling & waitlist</div>
              <div className="pricing-feature">Tax dashboard & HMRC tracking</div>
              <div className="pricing-feature">Receipt scanning</div>
              <div className="pricing-feature">Content autopilot</div>
              <div className="pricing-feature">Compliance & patch test tracking</div>
              <div className="pricing-feature">Analytics & reports</div>
              <div className="pricing-feature">120 messages/month included</div>
            </div>
            <a href="/login" className="pricing-cta-btn" onClick={goToLogin}>Try for free</a>
          </div>
        </div>

        <div style={{ textAlign: 'center', marginTop: '32px', maxWidth: '480px', marginLeft: 'auto', marginRight: 'auto' }}>
          <p className="mono" style={{ fontSize: '12px', color: '#867277' }}>Got a team? Add extra seats for £15/month each. Multi-location, staff rota, performance tracking included.</p>
        </div>
      </section>

      {/* Testimonial */}
      <section className="testimonial-section">
        <div className="container-narrow">
          <div className="testimonial-quote">
            <div className="quote-mark">"</div>
            <p className="testimonial-text">I used to spend my Sunday nights sorting next week's diary. Now Florrie does it in seconds.</p>
            <p className="testimonial-attribution">Maya P. — Brow artist, Manchester</p>
          </div>
        </div>
      </section>

      {/* Final CTA */}
      <section className="final-cta" id="start">
        <div className="container-narrow">
          <h2 className="display-italic">Your salon deserves this</h2>
          <p className="final-cta-subtext">14-day free trial. Everything included. No card required.</p>
          <a href="/login" className="final-cta-btn" onClick={goToLogin}>Try for free</a>
          <p className="form-note">Already have an account? <a href="/login" onClick={goToLogin} style={{ color: 'rgba(255,255,255,0.95)' }}>Sign in</a></p>
        </div>
      </section>

      {/* Footer */}
      <div className="landing-footer">
        <div className="footer-content">
          <div className="footer-logo">florrie</div>
          <span>© 2026</span>
          <div className="footer-links">
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
        </div>
      </div>
    </div>
  );
}
