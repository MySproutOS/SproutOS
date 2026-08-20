import "./globals.css"
import { ClientProviders } from "@website/components/ClientProviders"

export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang={"en"}>
      <body>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  )
}
