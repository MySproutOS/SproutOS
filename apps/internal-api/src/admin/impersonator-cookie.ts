/**
 * Where an admin's own session token waits while they are somebody else.
 *
 * There is one `session` cookie, so starting an impersonation overwrites it. The admin's session
 * row is untouched, but the browser stops holding its token — which made ending an impersonation a
 * sign-out until the flow was actually driven end to end.
 *
 * A constant in its own file because two routes need it and neither owns the other: the admin
 * surface sets it, and `/v1/user/me/impersonation` — which an impersonated session must be able to
 * reach, so it cannot live behind the admin middleware — clears it.
 */
export const IMPERSONATOR_COOKIE = "impersonator_session"
