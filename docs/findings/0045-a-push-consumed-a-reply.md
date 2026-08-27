# A push consumed a reply

## What was wrong

The Valkey proxy knew that a RESP2 array beginning with `message` could be either an unsolicited
pub/sub delivery or an ordinary command reply with coincidentally identical data. It handled the
initial `LRANGE` then `SUBSCRIBE` transition, but used the presence and position of a pending
subscription acknowledgement to choose between the two.

That rule fails after a subscription is already active. Given an ordinary pending command followed
by another `SUBSCRIBE`, a published message may arrive before either reply. Because a later pub/sub
acknowledgement was waiting, the proxy consumed the message as the ordinary command's reply. Every
subsequent response then belonged to the wrong request.

## Why the checks missed it

The A6 integration test covered unsolicited delivery, multiple subscription acknowledgements,
pattern subscriptions, unsubscribe transitions, and the message-shaped ordinary reply before the
first subscription. Each case passed. It did not combine an already-confirmed subscription, an
ordinary pending response, a later subscription acknowledgement, and a delivery between them.

This is the client-visible boundary from [[0013-the-boundary-you-cannot-test]] in miniature: tests
of the individual state transitions did not prove the ordering property of the composed protocol.

## What stops it coming back

The proxy now records subscribed mode only from the count in an acknowledgement returned by
Valkey. Before the first acknowledgement, a message-shaped array consumes its ordinary pending
slot. While the server-confirmed subscription count is nonzero, `message` and `pmessage` frames are
pushes and consume no slot, regardless of later pending subscription commands. A regression test
pins both sides of that distinction.

## Launch-plan context

This completes the pub/sub state-machine portion of A6 in
`/Users/andrew/.claude/plans/double-sorted-meteor.md`. The broader grouped implementation and its
reporting boundary remain in `private_notes/groups.md`: this is local and real-Valkey verification,
not production proof of the deployed router listener.
