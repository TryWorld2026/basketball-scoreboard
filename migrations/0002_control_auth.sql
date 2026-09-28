-- Controller credentials are independent of the public, read-only room code.
ALTER TABLE games ADD COLUMN controller_hash TEXT;

-- Durable idempotency receipts survive arbitrary match lengths and retries.
-- Receipts live as long as their match; abandoned game cleanup removes the game row.
CREATE TABLE action_receipts (
  code TEXT NOT NULL REFERENCES games(code) ON DELETE CASCADE,
  nonce TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (code, nonce)
);
