import { describe, it, expect } from 'vitest';
import { isTrainingEnquiry, renderCoursesBlock } from '../../src/lib/training-enquiry.js';

// "It's messing up me trying to get the training people enrolled." Every
// message below is the kind that reaches a salon that also teaches.

describe('isTrainingEnquiry: messages that are about learning the trade', () => {
  const yes = [
    'hi how much is your beginner course? x',
    'Do you do any training?',
    'do u teach lash lifts',
    'Hey! Are there any spaces on the next course',
    'I want to learn how to do lashes, where do I start',
    'Thinking about getting trained in brows, do you run courses',
    'What dates is the lash extension training',
    'is the masterclass accredited?',
    'do I need to bring a model for the course',
    'hiya can I enrol for october',
    'whats the deposit for the course',
    'I would love to become a lash tech, do you train people?',
    'Is a certificate included',
    'Course price?',
    'hello! Interested in the ultimate beginner course please x',
  ];
  for (const m of yes) {
    it(`hands over: ${m}`, () => {
      expect(isTrainingEnquiry(m)).toEqual({ yes: true, reason: 'training_enquiry' });
    });
  }
});

describe('isTrainingEnquiry: "of course" is not a course', () => {
  const no = [
    'Yes of course girl, could you get to me for 12.15 though? Xxx',
    'of course! see you thursday x',
    'Course you can lovely',
    'course thats fine',
    'in due course',
    'how much is a lash lift? x',
    'am I still booked for thursday',
    'can I move friday to sat pls',
    'what aftercare for a korean lift',
    'Is a patch test needed for brow lamination',
    'my friend trained with you years ago and said you were lovely, can I book a lift',
    '',
    null,
  ];
  for (const m of no) {
    it(`answers normally: ${JSON.stringify(m)}`, () => {
      expect(isTrainingEnquiry(m).yes).toBe(false);
    });
  }
});

describe('renderCoursesBlock', () => {
  it('says there is nothing open rather than inventing a course', () => {
    const block = renderCoursesBlock([], 'ellindigo');
    expect(block).toMatch(/none are open/);
    expect(block).toMatch(/do not quote a price/);
  });

  it('lists the facts a student is told, with the enrol link, and marks a full course', () => {
    const block = renderCoursesBlock([
      { id: 'c1', name: 'Ultimate Beginner Course', date: '2026-10-12', start_time: '09:30:00', duration: 'Full day (7hrs)', location: 'Ellindigo', price: 750, deposit: 150, max_students: 4, enrolled: 1 },
      { id: 'c2', name: 'Brow Lamination Masterclass', date: null, price: 250, deposit: 0, max_students: 2, enrolled: 2 },
    ], 'ellindigo');
    expect(block).toContain('Ultimate Beginner Course, on Monday 12 October 2026, starting 09:30, Full day (7hrs), at Ellindigo, £750, (£150 deposit to book), 3 places left, enrol: florrie.ai/training/ellindigo/c1');
    expect(block).toContain('Brow Lamination Masterclass, date to be confirmed, £250, FULL, enrol: florrie.ai/training/ellindigo/c2');
    expect(block).toMatch(/never offer appointment times/);
    expect(block).not.toMatch(/[\u2014\u2013]/);
  });
});
