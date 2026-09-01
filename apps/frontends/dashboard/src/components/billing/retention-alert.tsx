import { formatBalanceMicroUsd } from "@lib/billing/money"
import { Link } from "@tanstack/react-router"
import { Alert, AlertActions, AlertDescription, AlertTitle } from "@ui/base/ui/alert"
import { Button } from "@ui/base/ui/button"
import { Clock3, TriangleAlert } from "lucide-react"
import { useCreditBalance } from "@frontends/dashboard/data/billing"

const DEADLINE = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeStyle: "short",
})

export function RetentionAlert({ orgSlug }: { orgSlug: string }) {
  const { data } = useCreditBalance(orgSlug)
  if (data === undefined || data.warningStage === "safe") return null

  const suspended = ["suspended", "deletion_imminent", "deleting", "data_deleted"].includes(
    data.warningStage,
  )
  const title =
    data.warningStage === "warning"
      ? "Credit is below seven days of spendable runway"
      : data.warningStage === "critical"
        ? "Credit is below two days of spendable runway"
        : data.warningStage === "data_deleted"
          ? "Hosted provider data was deleted"
          : data.warningStage === "deleting"
            ? "Hosted provider-data deletion is in progress"
            : "Service is suspended to protect your data-retention reserve"

  return (
    <div className="px-4 pt-4 md:px-6">
      <Alert variant={suspended ? "destructive" : "warning"}>
        {suspended ? <TriangleAlert /> : <Clock3 />}
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription>
          <p>
            SproutOS protects {formatBalanceMicroUsd(data.retentionReserveMicros)} for 48 hours of
            retained data. Active service stops when only that reserve remains.
            {data.deleteAfter === null
              ? ""
              : ` Irreversible provider deletion may begin after ${DEADLINE.format(data.deleteAfter)}.`}
          </p>
        </AlertDescription>
        {data.retentionStatus !== "data_deleted" && data.retentionStatus !== "deleting" && (
          <AlertActions>
            <Button
              size="sm"
              render={<Link to="/orgs/$orgSlug/settings/billing" params={{ orgSlug }} />}
            >
              Add credit
            </Button>
          </AlertActions>
        )}
      </Alert>
    </div>
  )
}
