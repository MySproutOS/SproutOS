import { renderCliInstaller } from "../(unprotected)/(marketing)/download/cli-installer"
import { latestCliRelease } from "../(unprotected)/(marketing)/download/cli-release"

export const dynamic = "force-dynamic"

export async function GET() {
  try {
    const release = await latestCliRelease()
    if (release === null) {
      return new Response("The Sprout CLI has not been published yet.\n", { status: 503 })
    }
    return new Response(renderCliInstaller(release), {
      headers: {
        "cache-control": "no-store",
        "content-type": "text/x-shellscript; charset=utf-8",
        "x-content-type-options": "nosniff",
      },
    })
  } catch {
    return new Response("The Sprout CLI installer is temporarily unavailable.\n", { status: 503 })
  }
}
