import type * as React from "react"

import { cn } from "../lib/utils"

/*
  Dashboard table density is 28px rows with a 30px header. Ids are mono, money is
  mono and tabular, and money columns are right-aligned — `TableCell` takes
  `numeric` for the first two and `money` for the last, so a column can never be
  amber by accident.
*/
function Table({ className, ...props }: React.ComponentProps<"table">) {
  return (
    <div
      data-slot="table-container"
      className="w-full overflow-x-auto rounded-lg border border-border"
    >
      <table
        data-slot="table"
        className={cn("w-full caption-bottom border-collapse text-[13px]", className)}
        {...props}
      />
    </div>
  )
}

function TableHeader({ className, ...props }: React.ComponentProps<"thead">) {
  return (
    <thead
      data-slot="table-header"
      className={cn("bg-soil-800 [&_tr]:border-b [&_tr]:border-border", className)}
      {...props}
    />
  )
}

function TableBody({ className, ...props }: React.ComponentProps<"tbody">) {
  return (
    <tbody
      data-slot="table-body"
      className={cn("[&_tr:last-child]:border-0", className)}
      {...props}
    />
  )
}

function TableFooter({ className, ...props }: React.ComponentProps<"tfoot">) {
  return (
    <tfoot
      data-slot="table-footer"
      className={cn("border-t border-border bg-soil-800 font-medium", className)}
      {...props}
    />
  )
}

function TableRow({ className, ...props }: React.ComponentProps<"tr">) {
  return (
    <tr
      data-slot="table-row"
      className={cn(
        "h-7 border-b border-border/45 transition-colors hover:bg-soil-800/60 data-selected:bg-soil-800",
        className,
      )}
      {...props}
    />
  )
}

function TableHead({ className, ...props }: React.ComponentProps<"th">) {
  return (
    <th
      data-slot="table-head"
      className={cn(
        "eyebrow h-[30px] px-3.5 text-left align-middle text-[10px] whitespace-nowrap [&:has([role=checkbox])]:pr-0",
        className,
      )}
      {...props}
    />
  )
}

function TableCell({
  className,
  numeric = false,
  money = false,
  ...props
}: React.ComponentProps<"td"> & { numeric?: boolean; money?: boolean }) {
  return (
    <td
      data-slot="table-cell"
      className={cn(
        "px-3.5 align-middle whitespace-nowrap",
        numeric && "tnum font-mono text-xs text-muted-foreground",
        money && "tnum text-right font-mono text-xs text-husk",
        className,
      )}
      {...props}
    />
  )
}

function TableCaption({ className, ...props }: React.ComponentProps<"caption">) {
  return (
    <caption
      data-slot="table-caption"
      className={cn("mt-3 text-xs text-muted-foreground", className)}
      {...props}
    />
  )
}

export { Table, TableHeader, TableBody, TableFooter, TableRow, TableHead, TableCell, TableCaption }
