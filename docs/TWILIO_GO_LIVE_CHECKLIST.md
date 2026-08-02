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
- Console, Messaging, Content Template Builder: recreate the five starter pack bodies (booking_confirmation_v4, reminder_24h_v4, gap_fill_offer_v4, rebook_nudge_v4, generic_message_v4), submit for WhatsApp approval.
- Copy the bodies and the variable order from `backend/src/lib/whatsapp-templates.js`. Twilio variables are positional, exactly like Meta's, so the order has to match or the salon name lands in the date slot:

| Template | {{1}} | {{2}} | {{3}} | {{4}} |
| --- | --- | --- | --- | --- |
| booking_confirmation_v4 | client name | salon name | date | time |
| reminder_24h_v4 | client name | salon name | treatment | time |
| gap_fill_offer_v4 | client name | salon name | day | time |
| rebook_nudge_v4 | client name | salon name | | |
| generic_message_v4 | client name | salon name | message | |

- Set `TWILIO_CONTENT_SIDS` to a JSON map, for example `{"booking_confirmation_v4":"HX..."}`. One global map is right: the v4 bodies name no salon, so a SID identifies a message rather than a customer.
- Unmapped names fall back to the previous version if that one is mapped, then to plain text, which only delivers inside the 24 hour window.

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
