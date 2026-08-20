"use client"

import { Icons } from "@website/components/icons"
import { Button } from "@ui/base/ui/button"
import { Checkbox } from "@ui/base/ui/checkbox"
import { Label } from "@ui/base/ui/label"
import Link from "next/link"
import { useCallback, useId, useState } from "react"

export function SignInForm() {
  const [signInError, setSignInError] = useState<string | null>(null)
  const [agreedToTerms, setAgreedToTerms] = useState(false)
  const termsId = useId()

  const handleTermsChange = useCallback((checked: boolean) => {
    setAgreedToTerms(checked)
  }, [])

  const handleGoogleClick = useCallback(() => {
    if (!agreedToTerms) {
      setSignInError("Please agree to the terms and conditions to continue")
      return
    }
    // A full-page navigation, not a router push: /login/google is a Route Handler that 302s to
    // Google, so there is no Next.js page for the client router to render. It must not go through
    // a Server Action either — those are POSTed, and the redirect keeps the method, which lands
    // on the GET-only handler as a 405.
    window.location.href = "/login/google"
  }, [agreedToTerms])

  return (
    <div className="grid gap-6">
      {signInError && (
        <div className="p-4 bg-red-100 text-red-900 rounded-md">Error: {signInError}</div>
      )}

      <div className="flex items-center flex-row gap-x-2 mb-4">
        <Checkbox id={termsId} checked={agreedToTerms} onCheckedChange={handleTermsChange} />
        <Label htmlFor={termsId} className="text-sm">
          <p>
            I agree to the{" "}
            <Link href="/legal/community-terms" className="text-blue-600 hover:underline">
              Terms of Service
            </Link>
            ,{" "}
            <Link href="/legal/privacy-policy" className="text-blue-600 hover:underline">
              Privacy Policy
            </Link>
            , and{" "}
            <Link href="/legal/code-of-conduct" className="text-blue-600 hover:underline">
              Community Code of Conduct
            </Link>
          </p>
        </Label>
      </div>

      <Button variant="outline" type="button" disabled={!agreedToTerms} onClick={handleGoogleClick}>
        <Icons.google className="mr-2 h-4 w-4" /> Google
      </Button>
    </div>
  )
}
