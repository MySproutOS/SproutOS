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
