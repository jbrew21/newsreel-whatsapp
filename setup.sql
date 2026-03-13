-- Newsreel WhatsApp — Supabase tables
-- Run this in Supabase SQL Editor (Dashboard > SQL Editor)

-- WhatsApp subscribers
CREATE TABLE IF NOT EXISTS whatsapp_subscribers (
  phone TEXT PRIMARY KEY,
  first_name TEXT,
  active BOOLEAN DEFAULT true,
  opted_in_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Poll/quiz responses from WhatsApp (and future platforms)
CREATE TABLE IF NOT EXISTS poll_responses (
  id BIGSERIAL PRIMARY KEY,
  phone TEXT NOT NULL,
  date DATE NOT NULL,
  story_idx INTEGER NOT NULL,
  response TEXT NOT NULL,         -- 'agree', 'neutral', 'disagree', or quiz answer
  platform TEXT DEFAULT 'whatsapp',
  responded_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(phone, date, story_idx, platform)
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_poll_responses_phone ON poll_responses(phone);
CREATE INDEX IF NOT EXISTS idx_poll_responses_date ON poll_responses(date);

-- RLS: service role can do everything, anon can read subscribers (for webhook)
ALTER TABLE whatsapp_subscribers ENABLE ROW LEVEL SECURITY;
ALTER TABLE poll_responses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Service role full access" ON whatsapp_subscribers
  FOR ALL USING (true) WITH CHECK (true);

CREATE POLICY "Service role full access" ON poll_responses
  FOR ALL USING (true) WITH CHECK (true);
