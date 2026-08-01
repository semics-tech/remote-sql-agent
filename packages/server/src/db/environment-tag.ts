import { and, eq } from 'drizzle-orm';
import { instances, workerInstanceConfigs } from './schema.js';

/**
 * Where an instance's environment tag lives, and how to reach it.
 *
 * The tag is a property of the *configuration* an admin saved, not of the
 * instance row the worker's Hello creates — the dashboard writes it to
 * `worker_instance_configs` and nothing else ever sets it. It is read here
 * through a join rather than copied onto `instances`, because the copy is what
 * goes stale: the tag would then have two writers, and the one that runs on
 * Hello is invisible until a worker happens to reconnect.
 *
 * An instance with no config row — enrolled from `worker.yaml` rather than the
 * dashboard — is untagged, and therefore reachable by the base role alone. That
 * is the documented fail-closed direction (docs/security.md), not an oversight.
 */
export const environmentTag = workerInstanceConfigs.environmentTag;

/** Join `instances` to the config row carrying its tag. Always a LEFT join. */
export const environmentTagJoin = and(
  eq(workerInstanceConfigs.workerId, instances.workerId),
  eq(workerInstanceConfigs.instanceName, instances.instanceName),
);
