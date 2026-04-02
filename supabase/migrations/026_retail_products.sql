-- Retail products — items beauticians sell through their booking page.
-- Separate from product_inventory (internal stock tracking).

CREATE TABLE IF NOT EXISTS retail_products (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT,
  price_cents INTEGER NOT NULL CHECK (price_cents > 0),
  image_url TEXT,
  category TEXT DEFAULT 'general'
    CHECK (category IN ('aftercare', 'styling', 'skincare', 'tools', 'general')),
  active BOOLEAN DEFAULT true,
  stock_qty INTEGER DEFAULT 0,          -- 0 = unlimited / not tracked
  max_per_order INTEGER DEFAULT 5,
  sort_order INTEGER DEFAULT 0,
  -- Link to product_inventory if tracked
  inventory_product_id UUID REFERENCES product_inventory(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Index for public booking page queries
CREATE INDEX IF NOT EXISTS idx_retail_products_beautician
  ON retail_products (beautician_id, active, sort_order);

-- Order items table — tracks what was purchased with a booking
CREATE TABLE IF NOT EXISTS order_items (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  client_id UUID REFERENCES clients(id) ON DELETE SET NULL,
  product_id UUID NOT NULL REFERENCES retail_products(id) ON DELETE CASCADE,
  quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_price_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  stripe_payment_intent_id TEXT,
  status TEXT DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'fulfilled', 'refunded', 'cancelled')),
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_order_items_beautician
  ON order_items (beautician_id, created_at DESC);

-- RLS
ALTER TABLE retail_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_items ENABLE ROW LEVEL SECURITY;

-- Beautician can manage their own products
CREATE POLICY retail_products_own ON retail_products
  FOR ALL USING (beautician_id = auth.uid());

-- Public can read active products (for booking page)
CREATE POLICY retail_products_public_read ON retail_products
  FOR SELECT USING (active = true);

CREATE POLICY order_items_own ON order_items
  FOR ALL USING (beautician_id = auth.uid());

-- Updated_at triggers
CREATE TRIGGER set_retail_products_updated_at
  BEFORE UPDATE ON retail_products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

CREATE TRIGGER set_order_items_updated_at
  BEFORE UPDATE ON order_items
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();
