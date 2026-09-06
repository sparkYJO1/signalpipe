import { Kafka, logLevel, type Producer, type Consumer } from "kafkajs";

export function makeKafka(clientId: string) {
  return new Kafka({
    clientId,
    brokers: (process.env.REDPANDA_BROKERS ?? "redpanda:9092").split(","),
    logLevel: logLevel.WARN,
    retry: { retries: 10, initialRetryTime: 500 },
  });
}

export async function connectProducer(clientId: string): Promise<Producer> {
  const p = makeKafka(clientId).producer({ allowAutoTopicCreation: true });
  await p.connect();
  return p;
}

export async function connectConsumer(
  clientId: string,
  groupId: string,
): Promise<Consumer> {
  const c = makeKafka(clientId).consumer({
    groupId,
    allowAutoTopicCreation: true,
  });
  await c.connect();
  return c;
}

/**
 * Partition key. See ADR-0004.
 *
 * Keyed by ecosystem + package, not by advisory id. Two advisories for the same
 * package must be processed in order, because the later one may supersede the
 * earlier. Keying by advisory id would spread load perfectly and lose that.
 */
export function partitionKey(ecosystem: string, packageName: string): string {
  return `${ecosystem}/${packageName}`;
}
