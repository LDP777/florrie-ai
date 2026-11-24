// Keep this history in the app bundle so each build describes features it has.
// Dates are release dates, not commit-author dates. See docs/app-updates.md.
export const APP_UPDATES = [
  {
    date: '2026-11-24',
    changes: [
      {
        id: 'clearer-training-booking',
        title: 'A simpler training booking page',
        description: 'Clearer date choices, an upfront deposit and a shorter booking form. Students can still read your full course details and add questions before booking.',
        to: '/courses', linkLabel: 'Open your courses',
        commits: ['8b47ea3'],
      },
      {
        id: 'public-training-links',
        title: 'Course links open straight to your dates',
        description: 'Students can view your courses and choose a training date without signing in or setting up a salon account.',
        to: '/courses', linkLabel: 'Open your courses',
        commits: ['59936a1'],
      },
      {
        id: 'full-training-descriptions',
        title: 'Room for your full course details',
        description: 'Write or paste longer training descriptions without the old text limit. Students can open the full outline, with your paragraphs and lists kept intact.',
        to: '/courses', linkLabel: 'Edit your courses',
        commits: ['366d013'],
      },
    ],
  },
  {
    date: '2026-11-23',
    changes: [
      {
        id: 'google-review-requests-after-visits',
        title: 'Ask for Google reviews after a visit',
        description: 'Add your Google review link, then choose automatic requests or approve each one. Clients can also leave a review from their completed booking.',
        to: '/reviews', linkLabel: 'Set up reviews',
        commits: ['2a82086'],
      },
    ],
  },
  {
    date: '2026-11-22',
    changes: [
      {
        id: 'money-monthly-diary',
        title: 'Clearer income and recent payments',
        description: 'Compare income with the same dates last month and see your latest payments. Payments recorded on completion can be marked unpaid in Income.',
        to: '/money', linkLabel: 'Open Money',
        commits: ['8c809ee', '1c03bf8'],
      },
      {
        id: 'hours-for-specific-dates',
        title: 'Work extra hours on selected dates',
        description: 'Choose a day in your calendar and tap Hours for this day, or set hours for several dates together. Your usual week stays the same.',
        to: '/hours', linkLabel: 'Set your hours',
        commits: ['81b3578'],
      },
      {
        id: 'time-off-editing',
        title: 'Keep your time off easy to manage',
        description: 'Usual hours, specific dates and time off now share one page. Tap a saved block to read its note, change it or remove it.',
        to: '/hours?tab=off', linkLabel: 'View time off',
        commits: ['81b3578'],
      },
    ],
  },
  {
    date: '2026-11-21',
    changes: [
      {
        id: 'iphone-startup',
        title: 'An iPhone startup fix',
        description: 'Fixed a crash when opening Florrie after an iOS update. Install the latest Florrie build to get this fix.',
        commits: ['ec31ad7'],
      },
    ],
  },
  {
    date: '2026-11-18',
    changes: [
      {
        id: 'money-receipts',
        title: 'See what’s been paid',
        description: 'The Income tab shows received payments. You can also record cash, bank transfers or payments taken on a separate card machine.',
        to: '/money?tab=income', linkLabel: 'Open Money',
        commits: ['45f7afd'],
      },
      {
        id: 'content-progress',
        title: 'Know when your content is ready',
        description: 'See Florrie’s progress as it prepares your content, then review the results before sharing.',
        to: '/content', linkLabel: 'Open Content',
        commits: ['62b3126'],
      },
    ],
  },
  {
    date: '2026-11-17',
    changes: [
      {
        id: 'commander-tasks',
        title: 'More useful things to ask Florrie',
        description: 'Check tomorrow’s appointments, plan your week or prepare a rebooking message straight from Ask Florrie.',
        to: '/voice', linkLabel: 'Try Ask Florrie',
        commits: ['cf77572', 'e6d50d9', 'd860236'],
      },
      {
        id: 'thoughtful-suggestions',
        title: 'Suggestions that fit your routine',
        description: 'Florrie can spot patterns in your diary, like taking bank holidays off. You review suggested calendar changes before saving.',
        to: '/today', linkLabel: 'Open Today',
        commits: ['dfa1672', 'afdb107'],
      },
      {
        id: 'appointment-care',
        title: 'Client checks in one place',
        description: 'Open an appointment to see its patch-test and consultation details together, including anything that needs your attention.',
        to: '/calendar', linkLabel: 'Open your calendar',
        commits: ['12090f8'],
      },
      {
        id: 'tax-summary',
        title: 'A simpler tax summary',
        description: 'See your income, expenses and estimated tax first. Open the breakdown when you want more detail.',
        to: '/money?tab=tax', linkLabel: 'View Tax',
        commits: ['b109547'],
      },
    ],
  },
  {
    date: '2026-11-16',
    changes: [
      {
        id: 'cancellation-payment-status',
        title: 'Check a cancellation fee',
        description: 'Money shows whether a cancellation fee was collected, is still pending or needs your attention.',
        to: '/money?tab=income', linkLabel: 'View payments',
        commits: ['45ed7aa', 'ecf5436'],
      },
      {
        id: 'inbox-handover',
        title: 'Know when Florrie needs you',
        description: 'The Inbox explains why a conversation was handed over, so you can see what needs your help.',
        to: '/inbox', linkLabel: 'Open Inbox',
        commits: ['cc8ffc3', '0280baa'],
      },
      {
        id: 'salon-campaigns',
        title: 'Content built around your salon',
        description: 'Prepare a campaign around your diary and goals, then review the posts before sharing them.',
        to: '/content', linkLabel: 'Plan your content',
        commits: ['a978eb3', 'bf47081'],
      },
    ],
  },
  {
    date: '2026-11-14',
    changes: [
      {
        id: 'privacy-eye',
        title: 'Show the app with more privacy',
        description: 'Tap the eye to hide client details and prices while you show someone the app. Payment status stays visible.',
        commits: ['61d562a', '0d08c9c'],
      },
      {
        id: 'personal-blocks',
        title: 'Edit your personal time',
        description: 'Tap a personal block in your calendar to read its note, change the time or remove it.',
        to: '/calendar', linkLabel: 'Open your calendar',
        commits: ['79586fd'],
      },
      {
        id: 'training-dates',
        title: 'Let students choose a training date',
        description: 'Offer several training dates and let students pick from the days you’ve set aside.',
        to: '/packages', linkLabel: 'View training',
        commits: ['0e02c2d', 'e3be0ab'],
      },
    ],
  },
];
