<!--
  Voice exemplar. The author's own published writing, verbatim, from
  robmclarty.com/words/write_self_documenting_code (2018-12-13). Only the 11ty
  front matter is stripped and the title restored as a heading. Whole article.
-->

# Write Self-Documenting Code

What does self-documenting code look like? I think the key is to write code in
such a way that it **tells a story** that explains *what* symbols are being
used, *how* they are being manipulated, and *why* they are being manipulated
(e.g., expected outcome).

When I'm choosing names for my functions and variables, I try to pick labels
that help me build "sentences" out of my logic statements. Like `isAdmin` or
`hasPermission()` so that I can construct "sentences" like:

```javascript
if (user.isAdmin && hasPermission('read:resource')) grantAccess()
```

But don't get too crazy with your naming. A single variable shouldn't be a whole
sentence on its own like this (poor example):

```javascript
const newGameUserSortedWithPermissions = User.find(userIdValueFromRequestParameter)
const resultOfUserBeingAuthenticated = newGameUserSortedWithPermissions.authenticateUsingPasswordFromRequest(httpsRequestParameters.userInputPasswordValue)
```

Things get hard to read. But similarly, don't go too light like this (other poor
example):

```javascript
const u = User.find(i)
const r = u.a(x)
```

This is equally hard to read because it isn't obvious what anything stands for.

Just like Goldilocks, you want it to be *just right*:

```javascript
const user = User.find(id)
const isAuthentic = user.login(req.password)
```

So if you write all your code to be self-documenting, when should you use a
comment?

Well, sometimes things are just too complex to be obvious just from the code.
Think of complex boolean algebra, or regex matches, or some kind of physics
formula that would be cumbersome if you didn't use shorthand variable names:

```javascript
const isValid = user.isAdmin || user.hasPermission('read:resource')
```
