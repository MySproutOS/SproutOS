import { createFileRoute } from "@tanstack/react-router"
import { useState } from "react"
import { Button } from "@ui/base/ui/button"
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@ui/base/ui/card"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { SkeletonText } from "@ui/base/ui/skeleton"
import { Switch } from "@ui/base/ui/switch"
import { ListError } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import { useUserProfile } from "@frontends/dashboard/data/members"

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
  timezone,
  productEmails: initialProductEmails,
}: {
  name: string
  email: string
  timezone: string
  productEmails: boolean
}) {
  const [name, setName] = useState(initialName)
  const [productEmails, setProductEmails] = useState(initialProductEmails)

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
          <Input id="profile-timezone" defaultValue={timezone} />
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
      <CardFooter className="justify-end">
        <Button>Save profile</Button>
      </CardFooter>
    </Card>
  )
}
