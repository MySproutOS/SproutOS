const STATUS = {
  ready: {
    status: "Ready",
    statusColor: "var(--leaf)",
    statusBg: "color-mix(in oklch, var(--leaf), transparent 88%)",
    statusBorder: "color-mix(in oklch, var(--leaf), transparent 70%)",
  },
  building: {
    status: "Building",
    statusColor: "var(--warning)",
    statusBg: "color-mix(in oklch, var(--warning), transparent 88%)",
    statusBorder: "color-mix(in oklch, var(--warning), transparent 70%)",
  },
  failed: {
    status: "Failed",
    statusColor: "var(--destructive)",
    statusBg: "color-mix(in oklch, var(--destructive), transparent 88%)",
    statusBorder: "color-mix(in oklch, var(--destructive), transparent 70%)",
  },
  sleeping: {
    status: "Sleeping",
    statusColor: "var(--muted-foreground)",
    statusBg: "transparent",
    statusBorder: "var(--border)",
  },
}

return {
  projects: [
    {
      glyph: "🍲",
      name: "Recipe Box",
      repo: "andrew-chen-wang/recipe-box",
      cost: "$0.04",
      updated: "2 hours ago",
      region: "us-east-1",
      hasUpdate: true,
      ...STATUS.ready,
    },
    {
      glyph: "💬",
      name: "Message Search",
      repo: "andrew-chen-wang/imessage-rag",
      cost: "$1.87",
      updated: "yesterday",
      region: "us-east-1",
      hasUpdate: false,
      ...STATUS.ready,
    },
    {
      glyph: "📮",
      name: "Client Follow-ups",
      repo: "acme-co/csm-automations",
      cost: "$0.31",
      updated: "4 minutes ago",
      region: "us-east-1",
      hasUpdate: false,
      ...STATUS.building,
    },
    {
      glyph: "📊",
      name: "Weekly Digest",
      repo: "andrew-chen-wang/weekly-digest",
      cost: "$0.00",
      updated: "12 days ago",
      region: "eu-west-1",
      hasUpdate: false,
      ...STATUS.sleeping,
    },
  ],
}
