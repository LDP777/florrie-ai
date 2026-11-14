# Client details eye toggle

The owner workspace has one eye button beside More. It switches client details off for showing the app to another person. A visible status remains on while details are hidden. The choice stays on this device across navigation and reloads and synchronises across web tabs.

## What remains visible

Diary dates, appointment times, treatments, counts and payment status remain visible. Prices, deposits, balances and monetary totals are concealed. Labels such as Paid, Deposit paid and Unpaid stay visible. Names become “Client”; client initials, contacts, photographs, message previews and bodies, notes, consultation answers/signatures, client-related AI prose, saved content and review text are concealed. Client edit, message-send, contact-link and export controls are concealed or disabled where using them without an identity would be unsafe. Dismiss and navigation controls remain available.

PrivateText and PrivateSection replace sensitive children at render time. Money conceals amounts automatically inside the owner provider; PrivateAmount covers other amount displays and editable values. They do not blur, alter fetched records, change outgoing payloads or write salon settings. PrivateText preserves the original child structure in normal mode when no wrapper props are requested. Public booking, login and consultation forms sit outside the owner provider and remain unaffected.

## Boundaries

This is an in-app display preference, not access control or a separate demo account. iOS notification previews, other apps, existing screenshots, previously copied material and exports are outside its scope. Background salon automation continues. Voice capture and new voice requests stop while the owner hides details so a demonstration cannot speak or submit a private command.

## Research

- Ledger uses a top-right eye to replace private balances when showing its app: https://www.ledger.com/how-to-keep-yourself-private-in-the-blockchain-world
- Discord Streamer Mode combines a global switch, an enabled banner and hidden identifying details: https://support.discord.com/hc/en-us/articles/218485407-Streamer-Mode-101
- W3C's toggle-button pattern supports a stable accessible label with aria-pressed: https://www.w3.org/WAI/ARIA/apg/patterns/button/

Florrie's button uses the stable accessible label “Hide client details”, aria-pressed, a 44px target and a status announcement. Focus remains on the button after activation.

## Regression checks

Run npm run check:privacy:browser --workspace frontend after the frontend build. The four suites use fictional records and blocked provider traffic. They cover the preference, reload/navigation, public-page isolation, inaccessible storage, render/ARIA/attribute concealment, clipboard/contact controls, unchanged edit state, actual diary/inbox/client screens, content/reviews/care components and secondary-page records. Normal voice and Content Team regression suites also pass.

New client-facing display fields in owner pages must use these shared primitives, including accessible labels, tooltips, images and editable values. Free-text output can contain identifying information even if it is not labelled as a client name.

## Amounts and payment status follow-up

The owner requested prices to be hidden while payment status remains visible. The follow-up covers monetary totals, appointment prices, deposits, balances, course fees, content-attributed booking values and amount fields. Public checkout and manage-booking amounts remain visible. Calendar and client-profile payment summaries retain confirmed paid, deposit-paid, unpaid, refunded and unconfirmed states; a request to pay in full is not payment evidence.

Validation: frontend build; 51 privacy groups (12 core, 14 primary, 12 content and 13 secondary); public booking-policy checks; mobile overflow. Synthetic fixtures verify DOM/attribute concealment, restored amounts, payment state, no provider traffic and no unintended writes.
