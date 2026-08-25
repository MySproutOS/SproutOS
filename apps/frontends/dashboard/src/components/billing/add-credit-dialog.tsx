import { formatMicroUsd, MINIMUM_TOPUP } from "@lib/billing/money"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui/base/ui/dialog"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { useState } from "react"
import { useAwaitTopup, useStartTopup, useTopupQuote } from "@frontends/dashboard/data/billing"
import { stripeConfigured, stripePromise, stripeTestMode } from "./stripe"

/** Dollars a person actually picks, as micro-USD. The field below takes anything above the floor. */
const PRESETS = [10n, 25n, 50n, 100n].map((dollars) => dollars * 1_000_000n)

/**
 * Add credit.
 *
 * The button on the billing page used to be a bare `<Button>Add credit</Button>` with no handler —
 * `docs/findings/0006-features-with-no-executor.md` in miniature. `POST /billing/topup` was
 * complete, the Stripe webhook that credits the ledger was complete, and the only missing piece was
 * the browser step between them, so pressing the button did nothing and said nothing.
 *
 * ## The money moves in one place and it is not here
 *
 * This component creates a PaymentIntent and confirms it. It never touches the balance. `settle()`
 * runs from `payment_intent.succeeded` in `stripe-webhooks.ts`, which means the ledger moves when
 * Stripe says the money moved. A closed tab still gets its credit; a double-clicked button does not
 * get charged twice; and a confirmation that succeeds while our API is deploying is still credited
 * when the webhook retries.
 *
 * So "succeeded" here says *payment accepted*, not *credit added*, and the copy has to match — a
 * balance that has not moved yet is the normal case for a second or two, and telling the customer
 * their credit is ready when it is not produces a support ticket for a system that is working.
 */
export function AddCreditDialog({ orgSlug }: { orgSlug: string }) {
  const [open, setOpen] = useState(false)

  if (!stripeConfigured) {
    return (
      <Button size="sm" className="self-start" disabled title="Card payments are not configured">
        Add credit
      </Button>
    )
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" className="self-start">
            Add credit
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add credit</DialogTitle>
          <DialogDescription>
            Credit is drawn down as you use the platform. There is no subscription.
          </DialogDescription>
        </DialogHeader>
        <AmountStep
          orgSlug={orgSlug}
          onDone={() => {
            setOpen(false)
          }}
        />
      </DialogContent>
    </Dialog>
  )
}

function AmountStep({ orgSlug, onDone }: { orgSlug: string; onDone: () => void }) {
  const [amountMicroUsd, setAmount] = useState<bigint>(PRESETS[1])
  const [clientSecret, setClientSecret] = useState<string | null>(null)
  const startTopup = useStartTopup(orgSlug)
  const quote = useTopupQuote(orgSlug, amountMicroUsd, clientSecret === null)

  /*
    `night`, because ADR 0010 makes the product dark-only.

    Stripe Elements renders in its own iframe with its own stylesheet, so none of the page's tokens
    reach it and its default is light. The first version omitted this and put four white
    payment-method rows inside a dark dialog — not broken, just obviously not part of the product.
    The variables pin the surface to the card colour rather than Stripe's near-black, so the element
    sits on the dialog instead of floating above it.
  */
  if (clientSecret !== null) {
    return (
      <Elements
        stripe={stripePromise()}
        options={{
          clientSecret,
          appearance: {
            theme: "night",
            variables: {
              colorBackground: "#111813",
              colorPrimary: "#8fce9b",
              colorText: "#e6efe8",
              borderRadius: "8px",
              fontFamily: "inherit",
            },
          },
        }}
      >
        <PaymentStep orgSlug={orgSlug} onDone={onDone} />
      </Elements>
    )
  }

  const belowMinimum = amountMicroUsd < MINIMUM_TOPUP

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        startTopup.mutate(
          { path: { orgSlug }, body: { amountMicroUsd: amountMicroUsd.toString() } },
          {
            onSuccess: (result) => {
              // Null means Stripe took the payment without needing the browser — a saved card
              // charged off-session. There is nothing to confirm, so the dialog is done.
              if (result.clientSecret === null) onDone()
              else setClientSecret(result.clientSecret)
            },
          },
        )
      }}
    >
      <div className="flex gap-2">
        {PRESETS.map((preset) => (
          <Button
            key={preset.toString()}
            type="button"
            variant={preset === amountMicroUsd ? "default" : "outline"}
            size="sm"
            onClick={() => {
              setAmount(preset)
            }}
          >
            {formatMicroUsd(preset)}
          </Button>
        ))}
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="topup-amount">Amount (USD)</Label>
        <Input
          id="topup-amount"
          type="number"
          min="1"
          step="1"
          value={(amountMicroUsd / 1_000_000n).toString()}
          onChange={(event) => {
            const dollars = Number(event.target.value)
            // Integer dollars only: micro-USD is a bigint and a fractional entry would round
            // somewhere invisible. Stripe's own minimum is a floor beneath ours anyway.
            setAmount(
              Number.isFinite(dollars) ? BigInt(Math.max(0, Math.floor(dollars))) * 1_000_000n : 0n,
            )
          }}
        />
      </div>

      {/*
        The fee is quoted by the server. Computing it here would be a second implementation of
        `processingFee`, and the customer would be shown one number and charged another.
      */}
      {quote.data !== undefined && (
        <dl className="flex flex-col gap-1 text-[13px] text-muted-foreground">
          <div className="flex justify-between">
            <dt>Charged to your card</dt>
            <dd>{formatMicroUsd(BigInt(quote.data.chargeMicroUsd))}</dd>
          </div>
          <div className="flex justify-between">
            <dt>Processing fee</dt>
            <dd>−{formatMicroUsd(BigInt(quote.data.feeMicroUsd))}</dd>
          </div>
          {/*
            The line the customer is actually buying, and the one the first version left out.

            It showed the fee and the amount charged and stopped there, which reads as though $25
            buys $25 of credit and the fee is somebody else's problem. It is deducted: $25 charged,
            $1.025 fee, $23.975 credited. Leaving the third line off does not make the arithmetic
            wrong, it makes it invisible — and the customer finds out by comparing their balance
            against their card statement.
          */}
          <div className="flex justify-between border-t border-border pt-1 font-medium text-foreground">
            <dt>Credit added</dt>
            <dd>{formatMicroUsd(BigInt(quote.data.creditMicroUsd))}</dd>
          </div>
        </dl>
      )}

      {belowMinimum && (
        <p className="text-[13px] text-destructive">
          The smallest top-up is {formatMicroUsd(MINIMUM_TOPUP)}.
        </p>
      )}

      {startTopup.isError && (
        <p className="text-[13px] text-destructive">
          That top-up could not be started. Nothing has been charged.
        </p>
      )}

      <DialogFooter>
        <Button type="submit" disabled={belowMinimum || startTopup.isPending}>
          {startTopup.isPending ? "Starting…" : "Continue to payment"}
        </Button>
      </DialogFooter>
    </form>
  )
}

function PaymentStep({ orgSlug, onDone }: { orgSlug: string; onDone: () => void }) {
  const awaitTopup = useAwaitTopup(orgSlug)
  const stripe = useStripe()
  const elements = useElements()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault()
        if (stripe === null || elements === null) return
        setSubmitting(true)
        setError(null)
        void stripe
          .confirmPayment({
            elements,
            // The webhook is what credits the ledger, so there is nothing for a return page to do
            // and no state to carry back. Redirect only if the payment method demands one.
            redirect: "if_required",
          })
          .then((result) => {
            setSubmitting(false)
            if (result.error) {
              // Stripe's message is written for the cardholder and names the actual problem;
              // replacing it with our own wording loses "your card was declined" for "failed".
              setError(result.error.message ?? "That payment did not go through.")
              return
            }
            onDone()

            /*
              Close first, then wait for the balance to move.

              The customer is done — holding the dialog open on a spinner while a webhook we do not
              control makes up its mind would be making them wait for our plumbing. Closing and
              refreshing behind them means the card is right by the time they look at it, which is
              the thing that was broken: the dialog closed and the balance still said $0.00.
            */
            void awaitTopup()
          })
      }}
    >
      <PaymentElement />

      {/*
        Said before the card is typed, not after it is refused.

        Stripe rejects a real card in test mode with "Your card was declined", and the reason —
        that the request was in test mode — arrives as a second sentence that reads like
        boilerplate. So somebody whose card works everywhere else is told their card does not work,
        by a system that knew in advance it would refuse it. The key's prefix says which account
        this is; there is no reason to make the customer discover it.
      */}
      {stripeTestMode && (
        <p className="rounded-md border border-border bg-secondary/40 p-2.5 text-[13px] text-muted-foreground">
          <span className="font-medium text-foreground">Test mode.</span> Use{" "}
          <code className="font-mono">4242 4242 4242 4242</code> with any future expiry, any CVC and
          any postcode. A real card will be declined.
        </p>
      )}

      {error !== null && <p className="text-[13px] text-destructive">{error}</p>}

      <p className="text-[13px] text-muted-foreground">
        Your balance updates once the payment clears, usually within a few seconds.
      </p>

      <DialogFooter>
        <Button type="submit" disabled={stripe === null || submitting}>
          {submitting ? "Paying…" : "Pay"}
        </Button>
      </DialogFooter>
    </form>
  )
}
