==================================================================================================================================
FLORRIE.AI BACKEND - COMPLETE API SURFACE MAP
==================================================================================================================================


==================================================================================================================================
FILE: ai-actions.js
BASE ROUTE: /api/ai-actions
==================================================================================================================================

    1. GET    /api/ai-actions
       TABLE: ai_actions

    2. GET    /api/ai-actions/summary
       TABLE: ai_actions

==================================================================================================================================
FILE: appointments.js
BASE ROUTE: /api/appointments
==================================================================================================================================

    3. GET    /api/appointments
       TABLE: appointments

    4. POST   /api/appointments
       TABLE: treatments

    5. PATCH  /api/appointments/:id
       TABLE: appointments
       BODY:  cancellation_reason, ends_at, starts_at, status

    6. POST   /api/appointments/:id/complete
       TABLE: appointments
       BODY:  date

    7. GET    /api/appointments/slots
       TABLE: beauticians

==================================================================================================================================
FILE: booking.js
BASE ROUTE: /api/booking
==================================================================================================================================

    8. GET    /api/booking/:slug
       TABLE: beauticians

==================================================================================================================================
FILE: clients.js
BASE ROUTE: /api/clients
==================================================================================================================================

    9. GET    /api/clients
       TABLE: clients

   10. GET    /api/clients/:id
       TABLE: clients
       BODY:  health_data_consent, marketing_consent

   11. POST   /api/clients/refresh-intelligence

==================================================================================================================================
FILE: consultation-forms.js
BASE ROUTE: /api/consultation-forms
==================================================================================================================================

   12. GET    /api/consultation-forms
       TABLE: consultation_forms

   13. GET    /api/consultation-forms/:id
       TABLE: consultation_forms

   14. PATCH  /api/consultation-forms/:id
       TABLE: consultation_forms

   15. DELETE /api/consultation-forms/:id
       TABLE: consultation_forms

   16. GET    /api/consultation-forms/responses/list
       TABLE: consultation_responses

   17. GET    /api/consultation-forms/responses/:id
       TABLE: consultation_responses

   18. GET    /api/consultation-forms/public/:token
       TABLE: consultation_responses

==================================================================================================================================
FILE: content.js
BASE ROUTE: /api/content
==================================================================================================================================

   19. GET    /api/content
       TABLE: content_posts

   20. POST   /api/content/generate

   21. GET    /api/content/suggestions
       TABLE: appointments

   22. PATCH  /api/content/:id
       TABLE: content_posts

   23. POST   /api/content/:id/publish

   24. DELETE /api/content/:id
       TABLE: content_posts

==================================================================================================================================
FILE: escalations.js
BASE ROUTE: /api/escalations
==================================================================================================================================

   25. GET    /api/escalations
       TABLE: messages

   26. POST   /api/escalations/:messageId/resolve
       TABLE: messages

   27. GET    /api/escalations/count
       TABLE: messages

==================================================================================================================================
FILE: exports.js
BASE ROUTE: /api/exports
==================================================================================================================================

   28. GET    /api/exports/clients
       TABLE: clients

   29. GET    /api/exports/appointments
       TABLE: appointments

==================================================================================================================================
FILE: features.js
BASE ROUTE: /api/features
==================================================================================================================================

   30. GET    /api/features/daily-checklists
       TABLE: daily_checklists

   31. POST   /api/features/daily-checklists
       TABLE: daily_checklists

   32. PATCH  /api/features/daily-checklists/:id
       TABLE: daily_checklists

   33. DELETE /api/features/daily-checklists/:id
       TABLE: daily_checklists

   34. GET    /api/features/consultations
       TABLE: consultations

   35. POST   /api/features/consultations
       TABLE: consultations

   36. PATCH  /api/features/consultations/:id
       TABLE: consultations

   37. DELETE /api/features/consultations/:id
       TABLE: consultations

   38. GET    /api/features/patch-tests
       TABLE: patch_tests

   39. POST   /api/features/patch-tests
       TABLE: patch_tests

   40. PATCH  /api/features/patch-tests/:id
       TABLE: patch_tests

   41. DELETE /api/features/patch-tests/:id
       TABLE: patch_tests

   42. GET    /api/features/aftercare-messages
       TABLE: aftercare_messages

   43. POST   /api/features/aftercare-messages
       TABLE: aftercare_messages

   44. PATCH  /api/features/aftercare-messages/:id
       TABLE: aftercare_messages

   45. DELETE /api/features/aftercare-messages/:id
       TABLE: aftercare_messages

   46. GET    /api/features/packages
       TABLE: packages

   47. POST   /api/features/packages
       TABLE: packages

   48. PATCH  /api/features/packages/:id
       TABLE: packages

   49. DELETE /api/features/packages/:id
       TABLE: packages

   50. GET    /api/features/client-packages
       TABLE: client_packages

   51. POST   /api/features/client-packages
       TABLE: client_packages

   52. PATCH  /api/features/client-packages/:id
       TABLE: client_packages

   53. GET    /api/features/add-ons
       TABLE: add_ons

   54. POST   /api/features/add-ons
       TABLE: add_ons

   55. PATCH  /api/features/add-ons/:id
       TABLE: add_ons

   56. DELETE /api/features/add-ons/:id
       TABLE: add_ons

   57. GET    /api/features/gift-vouchers
       TABLE: gift_vouchers

   58. POST   /api/features/gift-vouchers
       TABLE: gift_vouchers

   59. PATCH  /api/features/gift-vouchers/:id
       TABLE: gift_vouchers

   60. DELETE /api/features/gift-vouchers/:id
       TABLE: gift_vouchers

   61. GET    /api/features/client-memberships
       TABLE: client_memberships

   62. POST   /api/features/client-memberships
       TABLE: client_memberships

   63. PATCH  /api/features/client-memberships/:id
       TABLE: client_memberships

   64. DELETE /api/features/client-memberships/:id
       TABLE: client_memberships

   65. GET    /api/features/membership-subscriptions
       TABLE: membership_subscriptions

   66. POST   /api/features/membership-subscriptions
       TABLE: membership_subscriptions

   67. PATCH  /api/features/membership-subscriptions/:id
       TABLE: membership_subscriptions

   68. GET    /api/features/loyalty-config
       TABLE: loyalty_config

   69. POST   /api/features/loyalty-config
       TABLE: loyalty_config

   70. GET    /api/features/loyalty-points
       TABLE: loyalty_points

   71. POST   /api/features/loyalty-points
       TABLE: loyalty_points

   72. GET    /api/features/referrals
       TABLE: referrals

   73. POST   /api/features/referrals
       TABLE: referrals

   74. PATCH  /api/features/referrals/:id
       TABLE: referrals

   75. GET    /api/features/revenue-goals
       TABLE: revenue_goals

   76. POST   /api/features/revenue-goals
       TABLE: revenue_goals

   77. PATCH  /api/features/revenue-goals/:id
       TABLE: revenue_goals

   78. DELETE /api/features/revenue-goals/:id
       TABLE: revenue_goals

   79. GET    /api/features/message-templates
       TABLE: message_templates

   80. POST   /api/features/message-templates
       TABLE: message_templates

   81. PATCH  /api/features/message-templates/:id
       TABLE: message_templates

   82. DELETE /api/features/message-templates/:id
       TABLE: message_templates

   83. GET    /api/features/automation-rules
       TABLE: automation_rules

   84. POST   /api/features/automation-rules
       TABLE: automation_rules

   85. PATCH  /api/features/automation-rules/:id
       TABLE: automation_rules

   86. DELETE /api/features/automation-rules/:id
       TABLE: automation_rules

   87. GET    /api/features/policies
       TABLE: policies

   88. POST   /api/features/policies
       TABLE: policies

   89. PATCH  /api/features/policies/:id
       TABLE: policies

   90. DELETE /api/features/policies/:id
       TABLE: policies

   91. GET    /api/features/intake-forms
       TABLE: intake_forms

   92. POST   /api/features/intake-forms
       TABLE: intake_forms

   93. PATCH  /api/features/intake-forms/:id
       TABLE: intake_forms

   94. DELETE /api/features/intake-forms/:id
       TABLE: intake_forms

   95. GET    /api/features/form-submissions
       TABLE: form_submissions

   96. POST   /api/features/form-submissions
       TABLE: form_submissions

   97. GET    /api/features/hours-exceptions
       TABLE: hours_exceptions

   98. POST   /api/features/hours-exceptions
       TABLE: hours_exceptions

   99. DELETE /api/features/hours-exceptions/:id
       TABLE: hours_exceptions

  100. GET    /api/features/client-tags
       TABLE: client_tags

  101. POST   /api/features/client-tags
       TABLE: client_tags

  102. DELETE /api/features/client-tags/:id
       TABLE: client_tags

  103. GET    /api/features/client-tag-assignments
       TABLE: client_tag_assignments

  104. POST   /api/features/client-tag-assignments
       TABLE: client_tag_assignments

  105. DELETE /api/features/client-tag-assignments/:id
       TABLE: client_tag_assignments

  106. GET    /api/features/reviews
       TABLE: reviews

  107. POST   /api/features/reviews
       TABLE: reviews

  108. PATCH  /api/features/reviews/:id
       TABLE: reviews

  109. GET    /api/features/end-of-day-reports
       TABLE: end_of_day_reports

  110. POST   /api/features/end-of-day-reports
       TABLE: end_of_day_reports

  111. GET    /api/features/portal-settings
       TABLE: portal_settings

  112. POST   /api/features/portal-settings
       TABLE: portal_settings

  113. GET    /api/features/rebook-reminders
       TABLE: rebook_reminders

  114. POST   /api/features/rebook-reminders
       TABLE: rebook_reminders

  115. PATCH  /api/features/rebook-reminders/:id
       TABLE: rebook_reminders

  116. DELETE /api/features/rebook-reminders/:id
       TABLE: rebook_reminders

  117. GET    /api/features/waitlist
       TABLE: waitlist

  118. POST   /api/features/waitlist
       TABLE: waitlist

  119. PATCH  /api/features/waitlist/:id
       TABLE: waitlist

  120. DELETE /api/features/waitlist/:id
       TABLE: waitlist

  121. GET    /api/features/messages
       TABLE: messages

  122. POST   /api/features/messages
       TABLE: messages

  123. GET    /api/features/campaigns
       TABLE: campaigns

  124. POST   /api/features/campaigns
       TABLE: campaigns

  125. PATCH  /api/features/campaigns/:id
       TABLE: campaigns

  126. GET    /api/features/content-posts
       TABLE: content_posts

  127. POST   /api/features/content-posts
       TABLE: content_posts

  128. PATCH  /api/features/content-posts/:id
       TABLE: content_posts

  129. DELETE /api/features/content-posts/:id
       TABLE: content_posts

  130. GET    /api/features/team-members
       TABLE: team_members

  131. POST   /api/features/team-members
       TABLE: team_members

  132. PATCH  /api/features/team-members/:id
       TABLE: team_members

  133. DELETE /api/features/team-members/:id
       TABLE: team_members

==================================================================================================================================
FILE: google-calendar.js
BASE ROUTE: /api/google-calendar
==================================================================================================================================

  134. GET    /api/google-calendar/callback
       TABLE: beauticians

  135. POST   /api/google-calendar/disconnect
       TABLE: beauticians

  136. POST   /api/google-calendar/sync
       TABLE: appointments

  137. POST   /api/google-calendar/sync-all
       TABLE: appointments

==================================================================================================================================
FILE: hours-exceptions.js
BASE ROUTE: /api/hours-exceptions
==================================================================================================================================

  138. GET    /api/hours-exceptions
       TABLE: hours_exceptions

  139. POST   /api/hours-exceptions
       TABLE: hours_exceptions

  140. DELETE /api/hours-exceptions/:id
       TABLE: hours_exceptions

==================================================================================================================================
FILE: locations.js
BASE ROUTE: /api/locations
==================================================================================================================================

  141. GET    /api/locations
       TABLE: locations
       BODY:  is_primary

  142. DELETE /api/locations/:id
       TABLE: locations

==================================================================================================================================
FILE: money.js
BASE ROUTE: /api/money
==================================================================================================================================

  143. GET    /api/money/pulse
       TABLE: transactions

  144. GET    /api/money/tax-summary
       TABLE: transactions

  145. POST   /api/money/expenses
       TABLE: expenses

  146. POST   /api/money/expenses/scan

  147. GET    /api/money/expenses
       TABLE: expenses

  148. GET    /api/money/transactions
       TABLE: transactions

==================================================================================================================================
FILE: notifications.js
BASE ROUTE: /api/notifications
==================================================================================================================================

  149. POST   /api/notifications/process-reminders

  150. POST   /api/notifications/send-sms
       TABLE: clients

  151. POST   /api/notifications/send-email
       TABLE: clients

  152. PATCH  /api/notifications/preferences
       TABLE: beauticians
       BODY:  client_reminder_prefs, notification_prefs

  153. GET    /api/notifications/sms/usage

==================================================================================================================================
FILE: photo-consent.js
BASE ROUTE: /api/photo-consent
==================================================================================================================================

  154. GET    /api/photo-consent/:clientId
       TABLE: clients

==================================================================================================================================
FILE: promo-codes.js
BASE ROUTE: /api/promo-codes
==================================================================================================================================

  155. GET    /api/promo-codes
       TABLE: promo_codes

  156. GET    /api/promo-codes/:id
       TABLE: promo_codes
       BODY:  valid_from, valid_until

  157. DELETE /api/promo-codes/:id
       TABLE: promo_codes

==================================================================================================================================
FILE: stripe.js
BASE ROUTE: /api/stripe
==================================================================================================================================

  158. POST   /api/stripe/cleanup-events

  159. POST   /api/stripe/webhook
       TABLE: stripe_events

==================================================================================================================================
FILE: treatments.js
BASE ROUTE: /api/treatments
==================================================================================================================================

  160. GET    /api/treatments
       TABLE: treatments

  161. POST   /api/treatments
       TABLE: treatments

  162. PATCH  /api/treatments/:id
       TABLE: treatments

  163. DELETE /api/treatments/:id
       TABLE: treatments

==================================================================================================================================
FILE: webhooks.js
BASE ROUTE: /api/webhooks
==================================================================================================================================

  164. POST   /api/webhooks/whatsapp
       TABLE: beauticians

  165. POST   /api/webhooks/twilio-sms
       TABLE: messages


==================================================================================================================================
TOTAL ENDPOINTS: 165
==================================================================================================================================
