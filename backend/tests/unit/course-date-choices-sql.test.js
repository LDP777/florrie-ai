import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const migration = readFileSync(new URL('../../../supabase/migrations/20261020_course_date_choices.sql', import.meta.url), 'utf8');
const original = readFileSync(new URL('../../../supabase/migrations/042_courses.sql', import.meta.url), 'utf8');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const AUTH = '33333333-3333-4333-8333-333333333333';
const OTHER_AUTH = '44444444-4444-4444-8444-444444444444';
const COURSE = '55555555-5555-4555-8555-555555555555';
const DATE_ONE = '66666666-6666-4666-8666-666666666666';
const DATE_TWO = '77777777-7777-4777-8777-777777777777';
let db;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon;
    CREATE ROLE authenticated;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS
      $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    CREATE FUNCTION uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
    CREATE TABLE beauticians(id uuid PRIMARY KEY, auth_id uuid NOT NULL);
  `);
  await db.exec(original);
  await db.exec(migration);
  await db.exec(migration);
  await db.exec(`
    GRANT USAGE ON SCHEMA public, auth TO authenticated, anon;
    GRANT SELECT ON beauticians TO authenticated;
    GRANT SELECT, INSERT, UPDATE, DELETE ON courses, course_enrollments TO authenticated;
    GRANT SELECT ON courses TO anon;
  `);
}, 20000);
afterAll(() => db.close());
beforeEach(async () => {
  await db.exec('BEGIN');
  await db.query('INSERT INTO beauticians(id,auth_id) VALUES($1,$2),($3,$4)', [OWNER, AUTH, OTHER, OTHER_AUTH]);
  await db.query(`
    INSERT INTO courses(id,beautician_id,name,date,start_time,description,location,duration,max_students,
      price,deposit,includes,enrolled,status,booking_slug)
    VALUES($1,$2,'Brow training','2050-11-01','09:00','Fictional training','Studio','Full day',4,
      750,150,'["kit","certificate"]',1,'active','demo-salon')
  `, [COURSE, OWNER]);
  await db.query("INSERT INTO course_enrollments(beautician_id,course_id,name,email,payment_status,amount_paid_cents) VALUES($1,$2,'Existing student','fictional@example.com','deposit_paid',15000)", [OWNER, COURSE]);
  await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [AUTH]);
  await db.exec('SET LOCAL ROLE authenticated');
});
afterEach(() => db.exec('ROLLBACK'));

const dates = () => [
  { id: DATE_ONE, date: '2050-11-08', start_time: '10:00', max_students: 3 },
  { id: DATE_TWO, date: '2050-11-15', start_time: null, max_students: 2 },
];
const add = (values = dates(), course = COURSE) => db.query('SELECT * FROM add_course_dates($1,$2::jsonb)', [course, JSON.stringify(values)]);
async function rejectSafely(call) {
  await db.exec('SAVEPOINT rejected_operation');
  await expect(call()).rejects.toThrow();
  await db.exec('ROLLBACK TO SAVEPOINT rejected_operation');
}

describe('Actual PostgreSQL offered training dates', () => {
  it('keeps existing single dates and student records unchanged before dates are added', async () => {
    const row = (await db.query('SELECT * FROM courses WHERE id=$1', [COURSE])).rows[0];
    expect(row.course_group_id).toBeNull();
    expect(row.enrolled).toBe(1);
    expect((await db.query('SELECT * FROM course_enrollments')).rows).toHaveLength(1);
  });

  it('adds several dates atomically with separate capacity and inherited course details', async () => {
    const result = (await add()).rows;
    expect(result).toHaveLength(3);
    const first = result.find(c => c.id === DATE_ONE);
    expect(first).toMatchObject({ beautician_id: OWNER, course_group_id: COURSE, name: 'Brow training',
      price: '750.00', deposit: '150.00', start_time: '10:00:00', max_students: 3, enrolled: 0,
      status: 'active', location: 'Studio', includes: ['kit', 'certificate'] });
    const anchor = result.find(c => c.id === COURSE);
    expect(anchor.enrolled).toBe(1);
    expect(anchor.start_time).toBe('09:00:00');
    expect((await db.query('SELECT course_id,amount_paid_cents FROM course_enrollments')).rows)
      .toEqual([{ course_id: COURSE, amount_paid_cents: 15000 }]);
  });

  it('returns the same records after a lost response without duplicating dates', async () => {
    const a = (await add()).rows;
    const b = (await add()).rows;
    expect(b.map(r => r.id)).toEqual(a.map(r => r.id));
    expect((await db.query('SELECT id FROM courses')).rows).toHaveLength(3);
  });

  it('rolls back the group assignment and all new dates if one is invalid', async () => {
    await rejectSafely(() => add([dates()[0], { ...dates()[1], date: '2000-01-01' }]));
    const rows = (await db.query('SELECT id,course_group_id FROM courses')).rows;
    expect(rows).toEqual([{ id: COURSE, course_group_id: null }]);
  });

  it.each([
    { date: '2050-02-31' },
    { date: '2050-2-03' },
    { start_time: '24:00' },
    { max_students: 0 },
    { max_students: 201 },
    { id: COURSE },
  ])('rejects invalid date input %j without altering existing bookings', async patch => {
    await rejectSafely(() => add([{ ...dates()[0], ...patch }]));
    expect((await db.query('SELECT id,enrolled,course_group_id FROM courses')).rows)
      .toEqual([{ id: COURSE, enrolled: 1, course_group_id: null }]);
  });

  it('rejects repeated date/time choices, including missing time and midnight', async () => {
    await rejectSafely(() => add([dates()[0], { ...dates()[0], id: DATE_TWO }]));
    await rejectSafely(() => add([{ ...dates()[0], start_time: null }, { ...dates()[0], id: DATE_TWO, start_time: '00:00' }]));
    expect((await db.query('SELECT id FROM courses')).rows).toHaveLength(1);
  });

  it('allows different offered start times on the same day with their own places', async () => {
    const rows = (await add([dates()[0], { ...dates()[0], id: DATE_TWO, start_time: '14:00', max_students: 1 }])).rows;
    expect(rows.filter(c => c.id !== COURSE).map(c => c.start_time)).toEqual(['10:00:00', '14:00:00']);
  });

  it('rejects changed retry payloads instead of moving an already saved date', async () => {
    await add([dates()[0]]);
    await rejectSafely(() => add([{ ...dates()[0], start_time: '12:00' }]));
    expect((await db.query('SELECT start_time FROM courses WHERE id=$1', [DATE_ONE])).rows[0].start_time).toBe('10:00:00');
  });

  it('checks ownership even though active courses have a public-read policy', async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [OTHER_AUTH]);
    await rejectSafely(() => add());
    // Active rows are visible, but the invoker cannot mutate another owner.
    expect((await db.query('SELECT course_group_id FROM courses WHERE id=$1', [COURSE])).rows[0].course_group_id).toBeNull();
  });

  it('does not allow a signed-out caller to invoke the authenticated operation', async () => {
    await db.query("SELECT set_config('request.jwt.claim.sub','',true)");
    await rejectSafely(() => add());
    const access = (await db.query(`
      SELECT has_function_privilege('anon','add_course_dates(uuid,jsonb)','EXECUTE') anon,
        has_function_privilege('authenticated','add_course_dates(uuid,jsonb)','EXECUTE') authenticated,
        prosecdef FROM pg_proc WHERE proname='add_course_dates'
    `)).rows[0];
    expect(access).toEqual({ anon: false, authenticated: true, prosecdef: false });
  });

  it('can add new active dates from a closed anchor without reopening or changing it', async () => {
    await db.query("UPDATE courses SET status='completed' WHERE id=$1", [COURSE]);
    const rows = (await add([dates()[0]])).rows;
    expect(rows.find(c => c.id === COURSE)).toMatchObject({ status: 'completed', enrolled: 1 });
    expect(rows.find(c => c.id === DATE_ONE)).toMatchObject({ status: 'active', enrolled: 0 });
  });

  it('prevents a stale owner form from moving a date or time already booked by students', async () => {
    await rejectSafely(() => db.query("UPDATE courses SET date='2050-12-01' WHERE id=$1", [COURSE]));
    await rejectSafely(() => db.query("UPDATE courses SET start_time='12:00' WHERE id=$1", [COURSE]));
    // A stale counter cannot conceal an actual enrolled student.
    await db.query('UPDATE courses SET enrolled=0 WHERE id=$1', [COURSE]);
    await rejectSafely(() => db.query("UPDATE courses SET start_time='12:00' WHERE id=$1", [COURSE]));
    expect((await db.query('SELECT start_time FROM courses WHERE id=$1', [COURSE])).rows[0].start_time).toBe('09:00:00');
  });

  it('allows an unbooked occurrence to be corrected, but protects an open checkout that may still settle', async () => {
    await add([dates()[0]]);
    await db.query("UPDATE courses SET start_time='12:00' WHERE id=$1", [DATE_ONE]);
    expect((await db.query('SELECT start_time FROM courses WHERE id=$1', [DATE_ONE])).rows[0].start_time).toBe('12:00:00');
    await db.query("INSERT INTO course_enrollments(beautician_id,course_id,name,email,stripe_payment_intent_id) VALUES($1,$2,'Checkout','fictional2@example.com','cs_test_open')", [OWNER, DATE_ONE]);
    await rejectSafely(() => db.query("UPDATE courses SET start_time='14:00' WHERE id=$1", [DATE_ONE]));
  });
});
