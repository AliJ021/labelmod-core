BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE catalog.attribute_term (
  kind text NOT NULL CHECK (kind IN ('color','size')),
  label text NOT NULL CHECK (label=btrim(label) AND length(label) BETWEEN 1 AND 64),
  normalized text GENERATED ALWAYS AS (lower(translate(label,'يك','یک'))) STORED,
  PRIMARY KEY(kind,normalized)
);
COMMIT;
