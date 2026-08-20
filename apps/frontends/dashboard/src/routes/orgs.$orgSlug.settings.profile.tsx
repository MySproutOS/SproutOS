import { createFileRoute } from "@tanstack/react-router"
import { Alert, AlertDescription } from "@ui/base/ui/alert"
import { useState } from "react"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { SkeletonText } from "@ui/base/ui/skeleton"
import { Switch } from "@ui/base/ui/switch"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import { useUpdateProfile, useUserProfile } from "@frontends/dashboard/data/members"

export const Route = createFileRoute("/orgs/$orgSlug/settings/profile")({
  component: ProfileSettings,
})

function ProfileSettings() {
  const { data, isPending, isError, refetch } = useUserProfile()

  return (
    <PageBody>
      {isPending && (
        <Card className="max-w-2xl">
          <CardContent>
            <SkeletonText />
          </CardContent>
        </Card>
      )}
      {isError && (
        <ListError
          title="Could not load your profile"
          onRetry={() => {
            void refetch()
          }}
        />
      )}
      {data !== undefined && (
        <ProfileForm
          key={data.email}
          name={data.name}
          email={data.email}
          timezone={data.timezone}
          productEmails={data.productEmails}
        />
      )}
    </PageBody>
  )
}

function ProfileForm({
  name: initialName,
  email,
  timezone: initialTimezone,
  productEmails: initialProductEmails,
}: {
  name: string
  email: string
  timezone: string
  productEmails: boolean
}) {
  const [name, setName] = useState(initialName)
  const [zone, setZone] = useState(initialTimezone)
  const [productEmails, setProductEmails] = useState(initialProductEmails)
  const update = useUpdateProfile()

  /*
    Only what changed goes in the body.

    A PATCH carrying every field would overwrite a preference someone set in another tab, and would
    make "save" on an untouched form a write.
  */
  const changes = {
    ...(name === initialName ? {} : { name: name.trim() }),
    ...(zone === initialTimezone ? {} : { timezone: zone }),
    ...(productEmails === initialProductEmails ? {} : { productEmails }),
  }
  const dirty = Object.keys(changes).length > 0

  return (
    <Card className="max-w-2xl">
      <CardHeader>
        <CardTitle>Your profile</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-name">Name</Label>
          <Input
            id="profile-name"
            value={name}
            onChange={(event) => {
              setName(event.target.value)
            }}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-email">Email</Label>
          <Input id="profile-email" value={email} disabled readOnly />
          <p className="text-[11px] text-muted-foreground">
            Your email comes from the identity provider you signed in with.
          </p>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="profile-timezone">Time zone</Label>
          <Input
            id="profile-timezone"
            value={zone}
            onChange={(event) => {
              setZone(event.target.value)
            }}
          />
          <p className="text-[11px] text-muted-foreground">
            An IANA name — <span className="font-mono">America/New_York</span>. Your local zone is{" "}
            <button
              type="button"
              className="font-mono underline underline-offset-2"
              onClick={() => {
                setZone(Intl.DateTimeFormat().resolvedOptions().timeZone)
              }}
            >
              {Intl.DateTimeFormat().resolvedOptions().timeZone}
            </button>
            .
          </p>
        </div>
        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
          <Label htmlFor="product-emails" className="flex-col items-start gap-0.5">
            Product emails
            <span className="text-[11px] font-normal text-muted-foreground">
              Release notes and incident summaries. Never marketing.
            </span>
          </Label>
          <Switch id="product-emails" checked={productEmails} onCheckedChange={setProductEmails} />
        </div>
      </CardContent>
      <CardFooter className="flex-col items-stretch gap-2">
        {update.isError ? (
          <Alert variant="destructive">
            <AlertDescription>
              {(update.error as { error?: { message?: string } } | undefined)?.error?.message ??
                "Your profile could not be saved"}
            </AlertDescription>
          </Alert>
        ) : null}
        <div className="flex items-center justify-end gap-3">
          {update.isSuccess && !dirty ? (
            <span className="text-xs text-muted-foreground">Saved</span>
          ) : null}
          <Button
            disabled={!dirty || update.isPending}
            onClick={() => {
              update.mutate({ body: changes })
            }}
          >
            {update.isPending ? "Saving…" : "Save profile"}
          </Button>
        </div>
      </CardFooter>
    </Card>
  )
}
