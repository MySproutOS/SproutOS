# Daytona reported a successful clone as failed

## What was wrong

During production acceptance, Daytona cloned the requested repository successfully: the checkout
had the intended credential-free origin, branch, commit, and files. Its structured clone call then
threw `SandboxUnavailableError`. `bootstrapSandbox` trusted the provider response alone, reported
`cloning the repository` as a problem, and the provisioning job marked the otherwise usable sandbox
failed.

Blindly retrying is not safe. The destination is no longer empty after the first attempt, and a
failed clone can leave anything from an empty `.git` directory to a checkout of the wrong branch.
Treating any existing directory as success would give the agent a repository different from the
one the customer selected.

## Why the checks missed it

The Daytona live test covered a successful structured clone and local tests covered a provider
failure. Neither represented the provider's ambiguous outcome: the operation completed remotely,
but the call reporting its result failed. This cannot be distinguished from a partial clone by the
exception alone.

## What stops it coming back

After a clone-provider error, bootstrap now inspects the durable checkout. Recovery succeeds only
when all four facts hold: the path is a Git work tree, `origin` is exactly the requested
credential-free GitHub URL, the current symbolic branch is exactly the requested branch, and
`HEAD` resolves to a commit. The inspection returns only an exit status, so even a regressed remote
containing a credential is never copied into control-plane logs or error reporting.

Any partial, wrong, detached, unborn, or credential-bearing checkout preserves the original clone
failure. Regression tests cover the recovered success and every rejected mismatch.
