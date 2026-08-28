import { formatBalanceMicroUsd, formatMicroUsd } from "@lib/billing/money"
import { createFileRoute } from "@tanstack/react-router"
import { Fragment, useState } from "react"
import { ChevronDown, Download } from "lucide-react"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Money } from "@ui/base/ui/money"
import { Progress } from "@ui/base/ui/progress"
import { Skeleton } from "@ui/base/ui/skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@ui/base/ui/table"
import { AddCreditDialog } from "@frontends/dashboard/components/billing/add-credit-dialog"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import {
  type Invoice,
  useCreditBalance,
  useDownloadStatement,
  useInvoices,
  useStatementDetail,
  useUsageLines,
} from "@frontends/dashboard/data/billing"

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
              Usage is measured durably; charges are posted to the append-only credit ledger.
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
              <Table className="min-w-[36rem] table-fixed">
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead className="w-36 text-right">Quantity</TableHead>
                    <TableHead className="w-28 text-right">Cost</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {usage.data.map((line, index) => (
                    <Fragment key={line.id}>
                      {usage.data?.[index - 1]?.category !== line.category && (
                        <TableRow>
                          <TableHead
                            colSpan={3}
                            scope="rowgroup"
                            className="h-auto bg-muted/30 py-2 text-xs font-semibold normal-case tracking-normal"
                          >
                            {line.category}
                          </TableHead>
                        </TableRow>
                      )}
                      <TableRow>
                        <TableCell className="min-w-0 whitespace-normal py-2 pl-7 sm:pl-9">
                          <div className="break-words">{line.label}</div>
                          {line.description !== null && (
                            <div className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground">
                              {line.description}
                            </div>
                          )}
                        </TableCell>
                        <TableCell numeric className="whitespace-normal break-words text-right">
                          {line.quantity}
                        </TableCell>
                        <TableCell money>{formatMicroUsd(line.costMicros)}</TableCell>
                      </TableRow>
                    </Fragment>
                  ))}
                </TableBody>
                {usage.summary !== undefined && (
                  <TableFooter>
                    {usage.summary.overheadMicros > 0n && (
                      <TableRow>
                        <TableCell colSpan={2} className="text-right text-muted-foreground">
                          Platform fee
                        </TableCell>
                        <TableCell money>{formatMicroUsd(usage.summary.overheadMicros)}</TableCell>
                      </TableRow>
                    )}
                    <TableRow>
                      <TableCell colSpan={2} className="text-right font-semibold">
                        Total
                      </TableCell>
                      <TableCell money className="font-semibold">
                        {formatMicroUsd(usage.summary.totalMicros)}
                      </TableCell>
                    </TableRow>
                  </TableFooter>
                )}
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
                <TableHead className="w-24 text-right">Usage</TableHead>
                <TableHead className="w-24 text-right">Fee</TableHead>
                <TableHead className="w-24 text-right">Total</TableHead>
                <TableHead className="w-24 text-right">Download</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoices.data.map((invoice) => (
                <StatementRow key={invoice.id} orgSlug={orgSlug} invoice={invoice} />
              ))}
            </TableBody>
          </Table>
        )}
      </section>
    </PageBody>
  )
}

function StatementRow({ orgSlug, invoice }: { orgSlug: string; invoice: Invoice }) {
  const [expanded, setExpanded] = useState(false)
  const detail = useStatementDetail(orgSlug, invoice.id, expanded)
  const download = useDownloadStatement(orgSlug)

  return (
    <>
      <TableRow>
        <TableCell>
          <Button
            variant="ghost"
            size="sm"
            aria-expanded={expanded}
            onClick={() => {
              setExpanded((value) => !value)
            }}
          >
            <ChevronDown
              className={expanded ? "rotate-180 transition-transform" : "transition-transform"}
            />
            <span className="font-mono">{invoice.number}</span>
          </Button>
        </TableCell>
        <TableCell>{invoice.period}</TableCell>
        <TableCell>
          <Badge variant={invoice.status === "finalized" ? "success" : "outline"}>
            {invoice.status === "finalized" ? "Final" : "Open"}
          </Badge>
        </TableCell>
        <TableCell money>{formatMicroUsd(invoice.subtotalMicros)}</TableCell>
        <TableCell money>{formatMicroUsd(invoice.overheadMicros)}</TableCell>
        <TableCell money>{formatMicroUsd(invoice.totalMicros)}</TableCell>
        <TableCell className="text-right">
          <Button
            variant="outline"
            size="sm"
            disabled={download.isPending}
            onClick={() => {
              download.mutate({ statementId: invoice.id, number: invoice.number })
            }}
          >
            <Download />
            PDF
          </Button>
          {download.isError && (
            <span role="alert" className="ml-2 text-xs text-destructive">
              Failed
            </span>
          )}
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={7} className="bg-muted/20 p-4">
            {detail.isPending && <Skeleton className="h-20 w-full" />}
            {detail.isError && (
              <ListError
                title="Could not load statement detail"
                onRetry={() => {
                  void detail.refetch()
                }}
              />
            )}
            {detail.data !== undefined && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Line</TableHead>
                    <TableHead>Project</TableHead>
                    <TableHead className="text-right">Quantity</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.data.lines.map((line) => (
                    <TableRow key={line.id}>
                      <TableCell>{line.label}</TableCell>
                      <TableCell>{line.projectName ?? "Organization-wide"}</TableCell>
                      <TableCell numeric className="text-right">
                        {line.quantity} {line.unit}
                      </TableCell>
                      <TableCell money>{formatMicroUsd(BigInt(line.amountMicroUsd))}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </TableCell>
        </TableRow>
      )}
    </>
  )
}
