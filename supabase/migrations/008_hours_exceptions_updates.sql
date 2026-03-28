-- Extend hours_exceptions table with additional columns for frontend compatibility
ALTER TABLE hours_exceptions 
ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'closed',
ADD COLUMN IF NOT EXISTS end_date DATE,
ADD COLUMN IF NOT EXISTS start_time TIME,
ADD COLUMN IF NOT EXISTS end_time TIME,
ADD COLUMN IF NOT EXISTS note TEXT,
ADD COLUMN IF NOT EXISTS notify_clients BOOLEAN DEFAULT true;

-- Create index for efficient date queries
CREATE INDEX IF NOT EXISTS idx_hours_exceptions_date_range 
ON hours_exceptions(beautician_id, date, end_date);
