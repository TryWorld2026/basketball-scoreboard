-- A duplicate nonce must not satisfy the state UPDATE in the same batch.
-- receipt_id identifies the row inserted by this exact write attempt.
-- Existing rows from 0002 remain valid with NULL receipt_id; only new attempts
-- need a marker because the UPDATE must prove this batch inserted the receipt.
ALTER TABLE action_receipts ADD COLUMN receipt_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS action_receipts_receipt_id_idx
  ON action_receipts (receipt_id)
  WHERE receipt_id IS NOT NULL;
