"use client"

import { Button } from "@ui/base/ui/button"
import { Checkbox } from "@ui/base/ui/checkbox"
import { Label } from "@ui/base/ui/label"
import { GitHubMark } from "@website/components/icons"
import Link from "next/link"
import { useCallback, useId, useState } from "react"

export function SignInForm() {
  const [signInError, setSignInError] = useState<string | null>(null)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const termsId = useId()

  const handleTermsChange = useCallback((checked: boolean) => {
    setAgreedToTerms(checked)
    setSignInError(null)
  }, [])

  const handleGitHubClick = useCallback(() => {
    if (!agreedToTerms) {
      setSignInError("Please agree to the terms and conditions to continue")
      return
    }
    // A full-page navigation, not a router push: /login/github is a Route Handler that 302s to
    // GitHub, so there is no Next.js page for the client router to render. It must not go through
    // a Server Action either — those are POSTed, and the redirect keeps the method, which lands
    // on the GET-only handler as a 405.
    window.location.href = "/login/github"
  }, [agreedToTerms])

  return (
    <div className="grid gap-6">
      {signInError ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
        >
          {signInError}
        </div>
      ) : null}

      <div className="mb-2 flex flex-row items-start gap-x-2">
        <Checkbox id={termsId} checked={agreedToTerms} onCheckedChange={handleTermsChange} />
        <Label htmlFor={termsId} className="text-sm font-normal text-muted-foreground">
          <p className="text-pretty">
            I agree to the{" "}
            <Link href="/legal" className="text-primary hover:underline">
              Terms of Service
            </Link>
            ,{" "}
            <Link href="/legal" className="text-primary hover:underline">
              Privacy Policy
            </Link>
            , and{" "}
            <Link href="/legal" className="text-primary hover:underline">
              Community Code of Conduct
            </Link>
          </p>
        </Label>
      </div>

      <Button
        size="lg"
        type="button"
        disabled={!agreedToTerms}
        onClick={handleGitHubClick}
        className="gap-2"
      >
        <GitHubMark className="size-4" />
        Continue with GitHub
      </Button>

      <p className="text-center font-mono text-xs text-muted-foreground">
        We ask for the least access we can. You grant repository permissions later, per project.
      </p>
    </div>
  )
}
