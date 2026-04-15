-- 042: Courses & course enrollments
-- Powers the training/masterclass feature (Packages.jsx + TrainingBooking.jsx)

CREATE TABLE IF NOT EXISTS courses (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  date DATE,
  location TEXT,
  duration TEXT,
  max_students INTEGER DEFAULT 4,
  price NUMERIC(10, 2) NOT NULL DEFAULT 0,
  deposit NUMERIC(10, 2) DEFAULT 0,
  includes JSONB DEFAULT '[]'::jsonb,
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'cancelled', 'completed', 'draft')),
  enrolled INTEGER DEFAULT 0,
  booking_slug TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS course_enrollments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  course_id UUID NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  email TEXT,
  phone TEXT,
  payment_status TEXT DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid', 'deposit_paid', 'paid')),
  amount_paid_cents INTEGER DEFAULT 0,
  stripe_payment_intent_id TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_courses_beautician ON courses(beautician_id);
CREATE INDEX IF NOT EXISTS idx_courses_date ON courses(beautician_id, date);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_course ON course_enrollments(course_id);
CREATE INDEX IF NOT EXISTS idx_course_enrollments_beautician ON course_enrollments(beautician_id);

-- RLS
ALTER TABLE courses ENABLE ROW LEVEL SECURITY;
ALTER TABLE course_enrollments ENABLE ROW LEVEL SECURITY;

CREATE POLICY courses_own ON courses FOR ALL
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

CREATE POLICY course_enrollments_own ON course_enrollments FOR ALL
  USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

-- Allow public inserts for course enrollments (from public booking page)
CREATE POLICY course_enrollments_public_insert ON course_enrollments FOR INSERT
  WITH CHECK (true);

-- Allow public reads of active courses (for public booking page)
CREATE POLICY courses_public_read ON courses FOR SELECT
  USING (status = 'active');
