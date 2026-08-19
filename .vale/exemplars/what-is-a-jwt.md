<!--
  Voice exemplar. The author's own published writing, verbatim, from
  robmclarty.com/words/what_is_a_jwt (2015-12-15). Only the 11ty
  front matter is stripped and the title restored as a heading. Opening through the first teaching section; the rest is upstream.
-->

# What is a JSON Web Token?

*Securely transfer claims between two parties*

> "A [JSON Web Token (JWT)](https://tools.ietf.org/html/rfc7519), pronounced 'jot',
> is a compact URL-safe means of representing claims to be transferred between two
> parties. The claims in a JWT are encoded as a JSON object that is digitally
> signed using JSON Web Signature (JWS)".


How we used to do authentication
--------------------------------

![Basic Auth Flow](flow_basic.jpg)

HTTP is a *stateless* protocol. That means it doesn't remember anything from
request to request. If you login for one request, you'll be forgotten, and will
need to login again to make another request. As you can imagine, this can get
very annoying fast.

The old-school solution has been to create what's called a "session". A session
is implemented in two parts:

1. An object stored on the server that remembers if a user is still logged in,
  a reference to their profile, etc.
2. A cookie on the client-side that stores some kind of ID that can be
  referenced on the server against the session object's ID.


Cookie-based Auth
-----------------

![Cookie-based Auth Flow](flow_cookie_session.jpg)

If a user visits a web page (makes a request) and the server detects a session
cookie, it will check if it currently has a session stored with the ID from the
cookie, and if that object is still valid (whatever that means: not expired, not
revoked, not blacklisted, etc.).

If the session is still valid, it will respond with the requested web page (or
data). If it finds a session object, that object can contain data in it and with
that, the server can "remember" who you are and what you were doing (e.g., if this
is an ecommerce store, what products you've added to our shopping cart).

If the session is not valid (or no session cookie was detected) it will respond
with some sort of error message saying that the request is "unauthorized".
