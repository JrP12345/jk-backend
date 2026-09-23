/**
 * Operator CLI command for dead-letter inspection and replay with audit logging.
 *
 * Usage:
 *   npx tsx scripts/operator-replay.ts --metrics
 *   npx tsx scripts/operator-replay.ts --list --kind=domain_event
 *   npx tsx scripts/operator-replay.ts --replay --kind=domain_event --id=<ID> --actor=<USER_ID>
 *   npx tsx scripts/operator-replay.ts --replay-all --kind=domain_event --actor=<USER_ID>
 */
import mongoose from "mongoose";
import { verifyEnv } from "../utilities/config.ts";
import {
  DEAD_LETTER_KINDS,
  listDeadLetters,
  replayDeadLetter,
  type DeadLetterKind,
} from "../services/deadLetterReplay.ts";
import { domainEventDeliveryWorker } from "../services/DomainEventDeliveryWorker.ts";

function parseArgs() {
  const args = process.argv.slice(2);
  const flags: Record<string, string | boolean> = {};

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, val] = arg.slice(2).split("=");
      flags[key] = val !== undefined ? val : true;
    }
  }
  return flags;
}

async function main() {
  const flags = parseArgs();
  verifyEnv();
  await import("../db.ts");

  const kind = (flags.kind as DeadLetterKind) || "domain_event";
  if (!DEAD_LETTER_KINDS.includes(kind)) {
    console.error(`Error: Unsupported kind '${kind}'. Allowed: ${DEAD_LETTER_KINDS.join(", ")}`);
    process.exit(1);
  }

  if (flags.metrics) {
    console.log("\nFetching Domain Event Metrics...");
    const metrics = await domainEventDeliveryWorker.getMetrics();
    console.table(metrics);
    process.exit(0);
  }

  if (flags.list) {
    console.log(`\nListing dead letters for kind: ${kind}...`);
    const limit = Number(flags.limit) || 20;
    const items = await listDeadLetters(kind, limit);
    if (items.length === 0) {
      console.log("No dead letters found.");
    } else {
      console.table(
        items.map((i) => ({
          id: i.id,
          status: i.status,
          deliveryKind: i.deliveryKind,
          attempts: `${i.attempts}/${i.maxAttempts}`,
          replays: `${i.replayCount}/${i.replayLimit}`,
          error: i.error.slice(0, 50),
          createdAt: i.createdAt,
        })),
      );
    }
    process.exit(0);
  }

  if (flags.replay) {
    const id = flags.id as string;
    const actor = flags.actor as string;
    if (!id || !actor) {
      console.error("Error: --replay requires both --id=<ID> and --actor=<USER_ID>");
      process.exit(1);
    }
    console.log(`Replaying dead letter [${kind}] ID: ${id} by Operator: ${actor}...`);
    const result = await replayDeadLetter(kind, id, actor);
    console.log("Result:", result);
    process.exit(0);
  }

  if (flags["replay-all"]) {
    const actor = flags.actor as string;
    if (!actor) {
      console.error("Error: --replay-all requires --actor=<USER_ID>");
      process.exit(1);
    }
    const limit = Number(flags.limit) || 50;
    const items = await listDeadLetters(kind, limit);
    console.log(`Found ${items.length} dead letters to replay...`);
    let replayedCount = 0;
    for (const item of items) {
      try {
        const res = await replayDeadLetter(kind, item.id, actor);
        if (res.state === "replayed") {
          replayedCount++;
          console.log(`[OK] Replayed ${item.id}`);
        } else {
          console.warn(`[SKIP] ${item.id} state: ${res.state}`);
        }
      } catch (err: any) {
        console.error(`[ERROR] Failed to replay ${item.id}:`, err?.message);
      }
    }
    console.log(`Completed: ${replayedCount}/${items.length} dead letters successfully requeued.`);
    process.exit(0);
  }

  console.log(`
Domain Event & Dead Letter Operator CLI
Options:
  --metrics                            Show real-time domain event queue metrics
  --list [--kind=domain_event]         List dead letter entries
  --replay --id=<ID> --actor=<USER_ID> Replay a single failed/dead_letter item
  --replay-all --actor=<USER_ID>       Replay all eligible dead letters
  --kind=<kind>                        notification_delivery | outbound_message | domain_event (default: domain_event)
  --limit=<n>                          Limit records for list or replay-all (default: 20)
  `);
  process.exit(0);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
