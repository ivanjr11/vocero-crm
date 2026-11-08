-- 065: la Cuenta de mensajes del split de 2026 (plantillas y pago). Aditiva y
-- anulable: una instancia con una sola ID sigue igual.
ALTER TABLE "meta_credentials" ADD COLUMN IF NOT EXISTS "messaging_account_id" text;
