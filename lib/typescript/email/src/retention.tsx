import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"
import { render } from "@react-email/render"
import React from "react"

export type RetentionNoticeStage =
  | "critical"
  | "suspended"
  | "deletion_imminent"
  | "reprieved"
  | "data_deleted"

export type RetentionNoticeInput = {
  stage: RetentionNoticeStage
  organizationName: string
  organizationSlug: string
  reserveMicroUsd: bigint
  deleteAfter: Date | null
  dashboardOrigin: string
}

const COPY: Record<RetentionNoticeStage, { subject: string; heading: string; body: string }> = {
  critical: {
    subject: "Your SproutOS credit is running low",
    heading: "Add credit soon",
    body: "Your organization has two days or less of spendable runway above its protected data-retention reserve.",
  },
  suspended: {
    subject: "SproutOS service suspended — 48-hour data retention started",
    heading: "Service has been suspended",
    body: "New service work has stopped. Your provider data is retained for at least 48 hours while you restore sufficient credit.",
  },
  deletion_imminent: {
    subject: "SproutOS provider-data deletion may begin within 24 hours",
    heading: "Data deletion is approaching",
    body: "Restore sufficient credit before the deadline. Once provider deletion begins, that data cannot be recovered.",
  },
  reprieved: {
    subject: "SproutOS data deletion cancelled",
    heading: "Your service has been reprieved",
    body: "Your credit now covers the protected retention reserve, so the deletion deadline has been cleared.",
  },
  data_deleted: {
    subject: "SproutOS provider-data deletion completed",
    heading: "Provider data has been deleted",
    body: "Hosted provider data was removed after the nonpayment retention window. Your GitHub repositories and retained billing records were not deleted.",
  },
}

function dollars(value: bigint): string {
  return `$${(Number(value) / 1_000_000).toFixed(2)}`
}

export function RetentionNotice(input: RetentionNoticeInput) {
  const copy = COPY[input.stage]
  const billingUrl = `${input.dashboardOrigin}/orgs/${input.organizationSlug}/settings/billing`
  const termsUrl = `${input.dashboardOrigin}/legal/terms`
  return (
    <Html>
      <Head />
      <Preview>{copy.subject}</Preview>
      <Body style={{ backgroundColor: "#0b100d", color: "#e6efe8", fontFamily: "sans-serif" }}>
        <Container style={{ margin: "0 auto", maxWidth: "560px", padding: "32px 20px" }}>
          <Heading>{copy.heading}</Heading>
          <Text>{copy.body}</Text>
          <Text>Organization: {input.organizationName}</Text>
          <Text>Protected 48-hour reserve: {dollars(input.reserveMicroUsd)}</Text>
          {input.deleteAfter === null ? null : (
            <Text>Deletion may begin after: {input.deleteAfter.toISOString()}</Text>
          )}
          <Section style={{ margin: "24px 0" }}>
            <Button
              href={billingUrl}
              style={{ backgroundColor: "#8fce9b", color: "#0b100d", padding: "12px 18px" }}
            >
              Review billing and add credit
            </Button>
          </Section>
          <Text>
            <Link href={termsUrl}>Read the retention terms</Link>
          </Text>
        </Container>
      </Body>
    </Html>
  )
}

export async function renderRetentionNotice(input: RetentionNoticeInput) {
  const component = <RetentionNotice {...input} />
  return {
    subject: COPY[input.stage].subject,
    html: await render(component),
    text: await render(component, { plainText: true }),
  }
}
