-- Service PSCs (letter codes such as J056, Y1BC) keep arriving through the
-- SAM and DIBBS lanes, whose pub.fsc upserts rely on the column default
-- ('deep' since 0005). Guard at the table: any non-numeric code is stored as
-- excluded on insert or update, whatever the loader passed.
BEGIN;
CREATE OR REPLACE FUNCTION pub.fsc_exclude_service_codes() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fsc !~ '^[0-9]{4}$' THEN
    NEW.render_depth := 'excluded';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS fsc_exclude_service_codes ON pub.fsc;
CREATE TRIGGER fsc_exclude_service_codes
  BEFORE INSERT OR UPDATE ON pub.fsc
  FOR EACH ROW EXECUTE FUNCTION pub.fsc_exclude_service_codes();
UPDATE pub.fsc SET render_depth = 'excluded' WHERE fsc !~ '^[0-9]{4}$' AND render_depth <> 'excluded';
COMMIT;
