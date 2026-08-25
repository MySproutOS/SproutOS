import { formatBalanceMicroUsd, formatMicroUsd } from "@lib/billing/money"
import { createFileRoute } from "@tanstack/react-router"
import { Badge } from "@ui/base/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Progress } from "@ui/base/ui/progress"
import { Skeleton } from "@ui/base/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { AddCreditDialog } from "@frontends/dashboard/components/billing/add-credit-dialog"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import { useCreditBalance, useInvoices, useUsageLines } from "@frontends/dashboard/data/billing"

export const Route = createFileRoute("/orgs/$orgSlug/settings/billing")({
  component: BillingSettings,
})

function BillingSettings() {
  const { orgSlug } = Route.useParams()
  const balance = useCreditBalance(orgSlug)
  const usage = useUsageLines(orgSlug)
  const invoices = useInvoices(orgSlug)

  return (
    <PageBody>
      <div className="grid gap-4 lg:grid-cols-[minmax(0,20rem)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <CardTitle>Credit balance</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {balance.isPending && <Skeleton className="h-16 w-full" />}
            {balance.isError && <ListError title="Could not load your balance" />}
            {balance.data !== undefined && (
              <>
                <Money size="lg" className="text-2xl">
                  {/*
                    Rounded down for a balance. The usage lines below keep every significant digit,
                    because a metered line genuinely costs a fraction of a cent — but nobody reads
                    what they have left as `$11.292288`.
                  */}
                  {formatBalanceMicroUsd(balance.data.balanceMicros)}
                </Money>
                <Progress
                  value={balance.data.percentRemaining}
                  indicatorClassName="bg-husk"
                  aria-label="Credit balance remaining"
                />
                <span className="text-[11px] text-muted-foreground">
                  {balance.data.runwayLabel}
                </span>
                <AddCreditDialog orgSlug={orgSlug} />
              </>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>This month</CardTitle>
            <CardDescription>
              Metered from the append-only ledger, not from a running total.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {usage.isPending && <Skeleton className="h-32 w-full" />}
            {usage.isError && (
              <ListError
                title="Could not load usage"
                onRetry={() => {
                  void usage.refetch()
                }}
              />
            )}
            {usage.data !== undefined && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead className="w-36 text-right">Quantity</TableHead>
                    <TableHead className="w-24 text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.data.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>{line.label}</TableCell>
                      <TableCell numeric className="text-right">
                        {line.quantity}
                      </TableCell>
                      <TableCell money>{formatMicroUsd(line.costMicros)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </div>

      <section className="flex flex-col gap-2.5">
        <h2 className="eyebrow">Invoices</h2>
        {invoices.isPending && <Skeleton className="h-24 w-full rounded-lg" />}
        {invoices.isError && (
          <ListError
            title="Could not load invoices"
            onRetry={() => {
              void invoices.refetch()
            }}
          />
        )}
        {invoices.data !== undefined && invoices.data.length === 0 && (
          <p className="rule-soft rounded-lg border px-3 py-6 text-center text-sm text-muted-foreground">
            No statements yet. The first one closes at the end of the month.
          </p>
        )}
        {invoices.data !== undefined && invoices.data.length > 0 && (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-40">Invoice</TableHead>
                <TableHead>Period</TableHead>
                <TableHead className="w-24">Status</TableHead>
                <TableHead className="w-24 text-right">Total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.data.map((invoice) => (
                <TableRow key={invoice.id}>
                  <TableCell numeric>{invoice.id}</TableCell>
                  <TableCell>{invoice.period}</TableCell>
                  <TableCell>
                    <Badge variant={invoice.status === "paid" ? "success" : "outline"}>
                      {invoice.status === "paid" ? "Paid" : "Open"}
                    </Badge>
                  </TableCell>
                  <TableCell money>{formatMicroUsd(invoice.totalMicros)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </PageBody>
  )
}
