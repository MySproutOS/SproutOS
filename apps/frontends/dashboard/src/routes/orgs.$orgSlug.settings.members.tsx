import { createFileRoute } from "@tanstack/react-router"
import { UserPlusIcon } from "lucide-react"
import { Avatar, AvatarFallback } from "@ui/base/ui/avatar"
import { Badge } from "@ui/base/ui/badge"
import { Button } from "@ui/base/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@ui/base/ui/dialog"
import { Input } from "@ui/base/ui/input"
import { Label } from "@ui/base/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@ui/base/ui/select"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@ui/base/ui/table"
import { ListError, ListSkeleton } from "@frontends/dashboard/components/list-states"
import { PageBody } from "@frontends/dashboard/components/shell/page-header"
import { ROLE_LABELS, type OrganizationRole } from "@frontends/dashboard/data/organizations"
import { useMembers } from "@frontends/dashboard/data/members"

export const Route = createFileRoute("/orgs/$orgSlug/settings/members")({
  component: MembersSettings,
})

const ROLES: OrganizationRole[] = ["owner", "admin", "member"]
const ROLE_ITEMS = ROLES.map((role) => ({ label: ROLE_LABELS[role], value: role }))

function MembersSettings() {
  const { orgSlug } = Route.useParams()
  const { data, isPending, isError, refetch } = useMembers(orgSlug)

  return (
    <PageBody>
      <div className="flex items-center justify-between gap-3">
        <h2 className="eyebrow">Members</h2>
        <Dialog>
          <DialogTrigger
            render={
              <Button size="sm">
                <UserPlusIcon />
                Invite
              </Button>
            }
          />
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Invite a member</DialogTitle>
              <DialogDescription>
                They receive an email and join this organization once they accept.
              </DialogDescription>
            </DialogHeader>
            <div className="flex flex-col gap-3">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="invite-email">Email</Label>
                <Input id="invite-email" type="email" placeholder="teammate@example.com" />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label>Role</Label>
                <Select items={ROLE_ITEMS} defaultValue="member">
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((role) => (
                      <SelectItem key={role} value={role}>
                        {ROLE_LABELS[role]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <DialogClose render={<Button variant="outline">Cancel</Button>} />
              <DialogClose render={<Button>Send invite</Button>} />
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>

      {isPending && <ListSkeleton rows={3} />}
      {isError && (
        <ListError
          title="Could not load members"
          onRetry={() => {
            void refetch()
          }}
        />
      )}

      {data !== undefined && (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Member</TableHead>
              <TableHead className="hidden sm:table-cell">Email</TableHead>
              <TableHead className="w-28">Role</TableHead>
              <TableHead className="hidden w-28 lg:table-cell">Joined</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((member) => (
              <TableRow key={member.id}>
                <TableCell>
                  <span className="flex items-center gap-2">
                    <Avatar className="size-5 rounded-full">
                      <AvatarFallback className="text-[10px]">
                        {member.name.slice(0, 1)}
                      </AvatarFallback>
                    </Avatar>
                    {member.name}
                  </span>
                </TableCell>
                <TableCell numeric className="hidden sm:table-cell">
                  {member.email}
                </TableCell>
                <TableCell>
                  <span className="flex flex-wrap gap-1">
                    {member.isOwner && <Badge>{ROLE_LABELS.owner}</Badge>}
                    {member.roleNames.map((roleName) => (
                      <Badge key={roleName} variant="muted">
                        {roleName}
                      </Badge>
                    ))}
                  </span>
                </TableCell>
                <TableCell className="hidden text-muted-foreground lg:table-cell">
                  {member.joinedLabel}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </PageBody>
  )
}
