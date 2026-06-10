# Onboarding at scale: the sprint that matters most

The single biggest gap between Florrie today and Florrie the company is that
connecting WhatsApp took weeks of founder time for ONE tenant (WABA payment
blocks, display name rejection, template approvals, phone reconciliation).
Until a lash tech can go from signup to Florrie-answering-her-clients in under
15 minutes without Levi touching anything, every sale costs days. This doc is
the decisive plan.

## The decision (already locked 2026-05-18, now sequenced)

Twilio as BSP for WhatsApp. Florrie absorbs per-message cost inside £29.
Bird stays for SMS through Sprint 4. Self-serve number connection via
Twilio's hosted onboarding inside Florrie's UI.

Why Twilio over raw Meta Embedded Signup: their senders API wraps WABA
creation, display name submission and quality monitoring behind one API;
their compliance team absorbs most of the Meta fights we lived through
(display names, business verification edge cases). Cost: roughly half a penny
to a penny per conversation on top, fine at 86% margin.

## Sprint plan (2 weeks of focused work)

Week 1, backend:
1. Twilio account + WhatsApp sender sandbox (Levi: 30 min, card + console).
2. `services/whatsapp-twilio.js` implementing the same interface as today's
   Cloud API sender (sendTemplate, sendText, webhook parser), selected per
   beautician by a `wa_provider` column. Existing Meta path stays for Ellie.
3. Twilio inbound webhook route with signature validation, mapped into the
   same processInboundMessage pipeline.
4. Template sync: starter pack creation through Twilio's content API
   (same personalised bodies, same _v3 names).

Week 2, the 15-minute flow:
5. Onboarding screen: "Connect WhatsApp" launches Twilio's embedded reg
   flow; poll sender status; flip `wa_provider='twilio'` when live.
6. Display name submitted automatically from business_name (same rule we
   learned the hard way: name must look like a real salon brand, the
   starter-pack approach of "Name + Beauty" fallback on rejection).
7. Self-test: Florrie texts the beautician's own phone "It's Florrie, we're
   live" and shows the green tick in-app when delivered.
8. Connection doctor card on /whatsapp surfacing the existing diagnostics
   (debug-hits, template status, phone health) in plain English.

## What Levi personally must do (everything else is code)

1. Create the Twilio account and request WhatsApp sender access (day 1).
2. Approve the per-message cost model (rough math: 120 msgs ≈ £1 extra
   per tenant per month, absorbed).
3. Decide Ellie migration timing (she stays on Meta direct until Twilio
   path is proven with 2-3 new tenants).

## Definition of done

A brand new account, on a phone, connects a fresh number and receives
Florrie's first autonomous reply within 15 minutes, with zero founder
involvement, three times in a row.
