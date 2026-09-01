import { Type } from "typebox"
import { Nullable, UUID7String } from "../utils/common.serializer"

/**
 * Money crosses the wire as a decimal string, never a number.
 *
 * Amounts are `bigint` micro-USD internally, and a balance of 9007199254740993
 * micro-USD is past what a JSON number can represent exactly. A string is the
 * only encoding that survives the round trip, and the client formats it rather
 * than doing arithmetic on it.
 */
const MicroUsdString = Type.String({ pattern: "^-?\\d+$" })

export const billingSchemaBalanceResponse = Type.Object({
  balanceMicroUsd: MicroUsdString,
  heldMicroUsd: MicroUsdString,
  availableMicroUsd: MicroUsdString,
  retentionReserveMicroUsd: MicroUsdString,
  spendableAboveReserveMicroUsd: MicroUsdString,
  requiredReloadMicroUsd: MicroUsdString,
  retentionStatus: Type.Union([
    Type.Literal("active"),
    Type.Literal("suspended"),
    Type.Literal("deleting"),
    Type.Literal("data_deleted"),
  ]),
  warningStage: Type.Union([
    Type.Literal("safe"),
    Type.Literal("warning"),
    Type.Literal("critical"),
    Type.Literal("suspended"),
    Type.Literal("deletion_imminent"),
    Type.Literal("deleting"),
    Type.Literal("data_deleted"),
  ]),
  exhaustedAt: Nullable(Type.String({ format: "date-time" })),
  deleteAfter: Nullable(Type.String({ format: "date-time" })),
  deletionStartedAt: Nullable(Type.String({ format: "date-time" })),
  deletionCompletedAt: Nullable(Type.String({ format: "date-time" })),
  currency: Type.String(),
})

export const billingSchemaQuoteQuery = Type.Object({
  amountMicroUsd: MicroUsdString,
})

export const billingSchemaQuoteResponse = Type.Object({
  chargeMicroUsd: MicroUsdString,
  feeMicroUsd: MicroUsdString,
  creditMicroUsd: MicroUsdString,
  minimumMicroUsd: MicroUsdString,
})

export const billingSchemaTopupRequest = Type.Object({
  amountMicroUsd: MicroUsdString,
})

export const billingSchemaTopupResponse = Type.Object({
  topupId: UUID7String,
  clientSecret: Nullable(Type.String()),
  chargeMicroUsd: MicroUsdString,
  feeMicroUsd: MicroUsdString,
  creditMicroUsd: MicroUsdString,
})

export const billingSchemaTransactionsQuery = Type.Object({
  cursor: Type.Optional(Type.String()),
  limit: Type.Optional(Type.Number({ minimum: 0, multipleOf: 1 })),
})

export const billingSchemaTransactionsResponse = Type.Object({
  data: Type.Array(
    Type.Object({
      id: UUID7String,
      kind: Type.String(),
      description: Nullable(Type.String()),
      amountMicroUsd: MicroUsdString,
      createdAt: Type.String({ format: "date-time" }),
    }),
  ),
  nextCursor: Nullable(Type.String()),
})

export const billingSchemaAutoReloadRequest = Type.Object({
  enabled: Type.Boolean(),
  thresholdMicroUsd: Type.Optional(MicroUsdString),
  amountMicroUsd: Type.Optional(MicroUsdString),
})

export const billingSchemaAutoReloadResponse = Type.Object({
  enabled: Type.Boolean(),
  thresholdMicroUsd: Nullable(MicroUsdString),
  amountMicroUsd: Nullable(MicroUsdString),
})

/**
 * One line of "what you have used this month", rated.
 *
 * `quantity` is a decimal string, not a number: byte-seconds run to 1e11 within a day and the
 * dimension rates are fractions of a micro-USD. Either end of that range loses precision as a
 * float, and this is the number a customer checks a bill against.
 */
export const billingSchemaUsageLine = Type.Object({
  dimension: Type.String(),
  label: Type.String(),
  quantity: Type.String(),
  unit: Type.String(),
  amountMicroUsd: Type.String(),
})

export const billingSchemaUsageResponse = Type.Object({
  periodStart: Type.String({ format: "date-time" }),
  periodEnd: Type.String({ format: "date-time" }),
  lines: Type.Array(billingSchemaUsageLine),
  /** Usage before the platform's overhead. */
  subtotalMicroUsd: Type.String(),
  overheadMicroUsd: Type.String(),
  totalMicroUsd: Type.String(),
  overheadBps: Type.Integer(),
  /**
   * Micro-USD per day, averaged over the period so far.
   *
   * What "runway" is computed from. Averaged rather than extrapolated from the last day, because a
   * single busy day would tell a customer they have three days left when they have thirty.
   */
  burnPerDayMicroUsd: Type.String(),
})

export const billingSchemaStatement = Type.Object({
  id: UUID7String,
  number: Type.String(),
  periodStart: Type.String({ format: "date-time" }),
  periodEnd: Type.String({ format: "date-time" }),
  status: Type.String(),
  subtotalMicroUsd: Type.String(),
  overheadMicroUsd: Type.String(),
  totalMicroUsd: Type.String(),
  finalizedAt: Nullable(Type.String({ format: "date-time" })),
})

export const billingSchemaStatementsResponse = Type.Object({
  data: Type.Array(billingSchemaStatement),
})

export const billingSchemaStatementParam = Type.Object({
  statementId: UUID7String,
})

export const billingSchemaStatementLine = Type.Object({
  id: UUID7String,
  kind: Type.Union([Type.Literal("usage"), Type.Literal("overhead")]),
  projectId: Nullable(UUID7String),
  projectName: Nullable(Type.String()),
  dimension: Nullable(Type.String()),
  label: Type.String(),
  quantity: Type.String(),
  unit: Type.String(),
  unitMicroUsd: Nullable(Type.String()),
  amountMicroUsd: Type.String(),
  description: Nullable(Type.String()),
})

export const billingSchemaStatementResponse = Type.Intersect([
  billingSchemaStatement,
  Type.Object({ lines: Type.Array(billingSchemaStatementLine) }),
])

export const billingSchemaStatementPdfResponse = Type.String({ format: "binary" })
