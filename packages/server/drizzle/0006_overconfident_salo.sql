-- The environment tag moves to the table that actually sets it.
--
-- `instances.environment_tag` never had a writer: the dashboard has always
-- written the tag to `worker_instance_configs`, so the column read as NULL for
-- every instance and the grant resolver saw an entirely untagged estate. The
-- first three statements are defensive rather than expected to move rows —
-- anything in the column was set by hand against the database.
--
-- An instance with no config row cannot carry a tag afterwards. That is the
-- intended model: such an instance came from `worker.yaml` rather than the
-- dashboard, and is reachable by base role alone.
UPDATE "worker_instance_configs" c
   SET "environment_tag" = i."environment_tag"
  FROM "instances" i
 WHERE i."worker_id" = c."worker_id"
   AND i."instance_name" = c."instance_name"
   AND c."environment_tag" IS NULL
   AND i."environment_tag" IS NOT NULL;--> statement-breakpoint

-- Tags are compared lowercase and trimmed, so store them that way. `''` was
-- previously accepted and matched nothing while also not counting as untagged.
UPDATE "worker_instance_configs"
   SET "environment_tag" = NULLIF(btrim(lower("environment_tag")), '')
 WHERE "environment_tag" IS DISTINCT FROM NULLIF(btrim(lower("environment_tag")), '');--> statement-breakpoint

-- Same normalisation for grants, which the unique index depends on. Where
-- normalising would collide — `Production` and `production` as separate rows —
-- keep the most privileged role, matching how the resolver combined them.
DELETE FROM "environment_grants" g
 WHERE EXISTS (
   SELECT 1 FROM "environment_grants" other
    WHERE other."subject_kind" = g."subject_kind"
      AND other."subject_key" = g."subject_key"
      AND btrim(lower(other."environment_tag")) = btrim(lower(g."environment_tag"))
      AND other."id" <> g."id"
      AND (
        array_position(ARRAY['Viewer','Operator','Editor','Admin'], other."role")
          > array_position(ARRAY['Viewer','Operator','Editor','Admin'], g."role")
        OR (other."role" = g."role" AND other."id" > g."id")
      )
 );--> statement-breakpoint

UPDATE "environment_grants"
   SET "environment_tag" = btrim(lower("environment_tag"))
 WHERE "environment_tag" <> btrim(lower("environment_tag"));--> statement-breakpoint

ALTER TABLE "instances" DROP COLUMN "environment_tag";
