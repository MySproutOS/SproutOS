import { ACMClient, DeleteCertificateCommand } from "@aws-sdk/client-acm"
import {
  ElasticLoadBalancingV2Client,
  RemoveListenerCertificatesCommand,
} from "@aws-sdk/client-elastic-load-balancing-v2"
import { withdrawRoute } from "@lib/lambda"
import type { DB } from "@sproutos/db"
import type { Redis } from "ioredis"
import type { Kysely } from "kysely"

export type CustomDomainTeardownClients = {
  valkey: Pick<Redis, "del">
  acm: Pick<ACMClient, "send">
  elb: Pick<ElasticLoadBalancingV2Client, "send">
  listenerArn?: string
}

/** Stop serving one custom domain and release its certificate, safely on retries. */
export async function tearDownCustomDomain(
  db: Kysely<DB>,
  domain: {
    id: string
    hostname: string
    isApex: boolean
    acmCertificateArn: string | null
  },
  clients: CustomDomainTeardownClients,
): Promise<void> {
  await withdrawRoute(clients.valkey as Redis, domain.hostname)
  if (domain.isApex) await withdrawRoute(clients.valkey as Redis, `www.${domain.hostname}`)

  if (
    clients.listenerArn !== undefined &&
    clients.listenerArn !== "" &&
    domain.acmCertificateArn !== null
  ) {
    try {
      await clients.elb.send(
        new RemoveListenerCertificatesCommand({
          ListenerArn: clients.listenerArn,
          Certificates: [{ CertificateArn: domain.acmCertificateArn }],
        }),
      )
      await clients.acm.send(
        new DeleteCertificateCommand({ CertificateArn: domain.acmCertificateArn }),
      )
    } catch (cause) {
      console.error("[domains] certificate cleanup failed", cause)
    }
  }

  await db
    .updateTable("customDomain")
    .set({ deletedAt: new Date(), updatedAt: new Date(), status: "pending" })
    .where("id", "=", domain.id)
    .execute()
}

export function customDomainTeardownClientsFromEnv(valkey: Redis): CustomDomainTeardownClients {
  const region = process.env.AWS_REGION ?? "us-east-1"
  return {
    valkey,
    acm: new ACMClient({ region }),
    elb: new ElasticLoadBalancingV2Client({ region }),
    listenerArn: process.env.TENANT_LISTENER_ARN,
  }
}
