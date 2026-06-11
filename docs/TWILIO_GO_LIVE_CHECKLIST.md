# Twilio WhatsApp go-live checklist

The code is shipped and dormant. These are the human steps, in order.

## 1. Account (30 min, card needed)
- Create the account at twilio.com, upgrade off trial.
- Note the Account SID (ACxxx) and Auth Token from the console home page.

## 2. Sender
- Buy a UK number (Phone Numbers, Buy a Number) or port one.
- Messaging, Senders, WhatsApp senders: register the number as a WhatsApp sender. Twilio submits it to Meta. Display name rule we learned the hard way: must read like a real salon brand.
- Wait for sender status Online. The sender address is `whatsapp:+44...`.

## 3. Railway env vars (then restart the service)
- `TWILIO_ACCOUNT_SID`
- `TWILIO_AUTH_TOKEN`
- `TWILIO_CONTENT_SIDS` (step 5, can come later)
- `TWILIO_API_BASE` only if Twilio region routing ever needs it, otherwise skip.

## 4. Webhook
- On the sender (or its Messaging Service), set "When a message comes in" to `https://api.florrie.ai/api/webhooks/twilio/whatsapp`, method POST.

## 5. Content templates
- Console, Messaging, Content Template Builder: recreate the five starter pack bodies (booking_confirmation_v3, reminder_24h_v3, gap_fill_offer_v3, rebook_nudge_v3, generic_message_v3), submit for WhatsApp approval.
- Set `TWILIO_CONTENT_SIDS` to a JSON map, for example `{"booking_confirmation_v3":"HX..."}`. Unmapped templates fall back to plain text, which only delivers inside the 24 hour window.

## 6. Flip one beautician (NOT Ellie, she stays on Meta)
In Supabase SQL editor:
```sql
UPDATE beauticians SET wa_provider = 'twilio',
  twilio_wa_sender = 'whatsapp:+44XXXXXXXXXX',
  whatsapp_connected = true
WHERE id = '<beautician_id>';
```

## 7. Test
- Message the sender from a personal phone: expect a Florrie reply and a thread row in the inbox.
- Book a test appointment: expect the confirmation template to land.
- Check Railway logs for `provider: 'twilio'` lines and zero 403s.
