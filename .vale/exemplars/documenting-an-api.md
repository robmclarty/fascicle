<!--
  Voice exemplar. Author's own writing, verbatim, from
  _writing/authz/cred_api.md (opening through the first API entry).
-->

# Cred API

Once you have [initialized](./initialization.md) Cred you will gain access to
a set of different functions you can call from it. All of these function can be
called from the main Cred object that was initialized (e.g., `cred.use()`).


Some functions
are focused on authentication (i.e., verifying that incoming credentials are
valid and generating new tokens from them), whereas other are focused on
authorization (i.e., given a token, determine if it is valid and grant access to
data/resources if the request is determined to be valid). Finally, the
initialization setting values are also included for convenient reference.

## Authentication

Use these functions to perform authentication-specific actions.

### `use`

Defines and stores an authentication strategy (a function) and returns an object
which will become each token's payload.

So, for example, you could define a set of logic that checks your database and
compares a username and password. If your logic passes, it will return a
user-defined object (up to you what that looks like) and this object will be
what is used for each tokens' body/payload.

You can name your strategy anything you like in the first parameter ;)

