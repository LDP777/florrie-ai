# Voice, Content and conversation visual pass

Voice Commander has a petal welcome, three editable starting cards and a framed composer. Initial welcome rendering no longer scrolls the hero out of view. Existing command deadlines and proposal confirmations stay in place.

Content uses a wider studio layout with a lead weekly planner, collapsible feed preview, clearer navigation and keyboard-accessible idea cards. Desktop ideas use two columns. The existing draft editing, search, scheduling and publishing handlers are unchanged.

Conversations show the next appointment on its own line. Reply settings sit in a disclosure with the current mode visible, while channel choices and suggested replies take less space. The chat height accounts for the More navigation; message groups retain their height so the latest message can scroll clear of the composer. The send button uses the actual arrow icon. Typed replies survive channel changes.

Validation: production build including 78-page render gate; More recovery suite; populated layouts at 320, 390 and 1024 pixels; checks for horizontal overflow, visible Voice welcome, composer clearance above navigation, last-message reachability and preserved drafts on channel switch. Reviewed screenshots with light and dark palette tokens; scoped contrast checks cover the three pages. Test screenshots are optional via VISUAL_OUTPUT_DIR. No live messages, posts or client-record writes were used for testing. Native keyboard and speech remain device checks.
