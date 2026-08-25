-- MailBlaster schema. Every statement is IF NOT EXISTS / additive, so this
-- file is safe to run on every cold start and after every deploy: it creates
-- what is missing and leaves existing data alone.

CREATE TABLE IF NOT EXISTS campaigns (
  id               BIGSERIAL PRIMARY KEY,
  name             TEXT,
  subject_template TEXT,
  from_email       TEXT,          -- owning Gmail account: history is scoped to this
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ,
  status           TEXT NOT NULL DEFAULT 'running'   -- running | done | stopped
);

-- The de-duplication authority: one row per address, ever. Lifetime state for
-- a person lives here, not on an individual send, so a reply to campaign 1
-- suppresses them from campaign 2.
CREATE TABLE IF NOT EXISTS recipients (
  id                     BIGSERIAL PRIMARY KEY,
  email                  TEXT NOT NULL UNIQUE,
  first_name             TEXT,
  full_name              TEXT,
  salutation_confidence  TEXT,
  status                 TEXT NOT NULL DEFAULT 'new', -- new|sent|replied|ooo|bounced|unsubscribed
  do_not_contact         BOOLEAN NOT NULL DEFAULT FALSE,
  replied_at             TIMESTAMPTZ,
  ooo_until              TIMESTAMPTZ,
  bounce_count           INT NOT NULL DEFAULT 0,
  last_sent_at           TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sends (
  id            BIGSERIAL PRIMARY KEY,
  campaign_id   BIGINT REFERENCES campaigns(id) ON DELETE SET NULL,
  recipient_id  BIGINT REFERENCES recipients(id) ON DELETE CASCADE,
  time          TIMESTAMPTZ NOT NULL,
  sender        TEXT,
  recipient     TEXT,
  name          TEXT,
  subject       TEXT,
  attachments   JSONB,
  status        TEXT,
  error         TEXT,
  body          TEXT,
  message_id    TEXT                    -- SMTP Message-ID: how replies match back
);

CREATE TABLE IF NOT EXISTS replies (
  id            BIGSERIAL PRIMARY KEY,
  recipient_id  BIGINT REFERENCES recipients(id) ON DELETE CASCADE,
  send_id       BIGINT REFERENCES sends(id) ON DELETE SET NULL,
  received_at   TIMESTAMPTZ NOT NULL,
  from_email    TEXT,
  subject       TEXT,
  snippet       TEXT,
  kind          TEXT NOT NULL,          -- reply | ooo | bounce | unsubscribe | auto
  in_reply_to   TEXT,
  mailbox       TEXT NOT NULL DEFAULT 'INBOX',
  imap_uid      BIGINT
);

-- Migrations for databases created by an earlier version of this file.
ALTER TABLE sends ADD COLUMN IF NOT EXISTS message_id   TEXT;
ALTER TABLE sends ADD COLUMN IF NOT EXISTS campaign_id  BIGINT;
ALTER TABLE sends ADD COLUMN IF NOT EXISTS recipient_id BIGINT;
ALTER TABLE sends ADD COLUMN IF NOT EXISTS body         TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS from_email TEXT;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS sent_count    INT NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS failed_count  INT NOT NULL DEFAULT 0;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS total_count   INT NOT NULL DEFAULT 0;

-- Follow-up tracking. A follow-up is a campaign whose parent_id points at the
-- run it chases, and round 1/2/3 is its depth. Keeping it on the campaign (not
-- inferring it from dates) is what lets the UI say "2nd follow-up" honestly.
ALTER TABLE campaigns  ADD COLUMN IF NOT EXISTS parent_id     BIGINT;
ALTER TABLE campaigns  ADD COLUMN IF NOT EXISTS followup_round INT NOT NULL DEFAULT 0;

-- Per-person counters, so nobody is chased forever: the composer can cap
-- follow-ups and show "3rd contact" next to a name.
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS followup_count INT NOT NULL DEFAULT 0;
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS last_followup_at TIMESTAMPTZ;
ALTER TABLE recipients ADD COLUMN IF NOT EXISTS contact_count  INT NOT NULL DEFAULT 0;

-- A follow-up threads onto the message it chases; storing the parent send lets
-- the viewer show the original underneath the reply, as Gmail does.
ALTER TABLE sends      ADD COLUMN IF NOT EXISTS in_reply_to_send BIGINT;
ALTER TABLE sends      ADD COLUMN IF NOT EXISTS followup_round   INT NOT NULL DEFAULT 0;

-- RFC 5322 3.6.4: References must carry the WHOLE ancestor chain (every prior
-- Message-Id in the thread), not just the immediate parent — In-Reply-To alone
-- covers the immediate parent. Without this, a 3rd-round follow-up could lose
-- older ancestors and thread incorrectly in stricter mail clients. Stored as a
-- JSON array of Message-Ids so it can just be appended to and passed straight
-- through to nodemailer's `references` option.
ALTER TABLE sends      ADD COLUMN IF NOT EXISTS references_json  TEXT;

-- Replies carry their own received time and a snippet so the list can be read
-- without refetching the mailbox.
ALTER TABLE replies    ADD COLUMN IF NOT EXISTS body TEXT;

-- Imported campaigns are badged as such in the UI, so history never implies
-- this tool sent mail that it did not.
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS imported      BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE campaigns ADD COLUMN IF NOT EXISTS import_source TEXT;
ALTER TABLE sends     ADD COLUMN IF NOT EXISTS imported      BOOLEAN NOT NULL DEFAULT FALSE;

-- No duplicate delivery inside one campaign, enforced by the database rather
-- than by the browser: two tabs or a retried request cannot double-send.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sends_campaign_recipient
  ON sends(campaign_id, recipient_id) WHERE campaign_id IS NOT NULL AND recipient_id IS NOT NULL;

-- Rescanning the same inbox never inserts the same reply twice.
CREATE UNIQUE INDEX IF NOT EXISTS idx_replies_uid ON replies(mailbox, imap_uid) WHERE imap_uid IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_sends_time       ON sends(time DESC);
CREATE INDEX IF NOT EXISTS idx_sends_message_id ON sends(message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sends_recipient  ON sends(recipient_id, status);
CREATE INDEX IF NOT EXISTS idx_recip_dnc        ON recipients(do_not_contact) WHERE do_not_contact = FALSE;
CREATE INDEX IF NOT EXISTS idx_replies_recip    ON replies(recipient_id, received_at DESC);
-- History is listed per Gmail account, newest first: this index serves that directly.
CREATE INDEX IF NOT EXISTS idx_campaigns_owner   ON campaigns(from_email, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_sends_sender_time ON sends(sender, time DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_parent   ON campaigns(parent_id) WHERE parent_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_recip_followups    ON recipients(followup_count);
