<!--
  Voice exemplar. The author's own published writing, verbatim, from
  robmclarty.com/words/dont_use_hpkp_by_default (2017-02-08). Only the 11ty
  front matter is stripped and the title restored as a heading. Whole article.
-->

# Don't Use HPKP by Default

Public key pinning is a tool that can be used to increase the trusworthiness of
an https website by throwing up red flags if a compromised certificate is used
in a TLS handshake when compared to the pinned keys being used. It is meant to
safeguard against a CA being compromised and issuing valid certs for your
domain.

For an attacker to be able to compromise a CA and then use that to attack your
website, they would need to be fairly sophisticated, state-level even.

But if you set it up wrong you could block your domain for all your users. Plus,
you actually increase your attack surface so that an attacker could hold your
domain hostage and require ransom to get it back. This is a balance of risk
versus benefit/security. In most cases, for non-critical sites (i.e., not a
bank, gov, hospital, or other desirable target worth attacking) it is my
opinion that the benefits don't outway the risks.


Benefits of HPKP
----------------

- prevent and detect fake TLS certificates


Downsides to HPKP
-----------------

- still can't be sure if the "valid" cert being used to make the pin is not
  compromised, which begs the question
- it can be very complicated to setup correctly
- if you get it wrong you can brick your domain (until it expires), or if your
  server is compromised (which is a lot easier for an attacker than
  compromising a CA) they could commit HPKP suicide on your behalf (and hold
  your domain ransom)
- recommended to get a 2nd cert from different CA for your domain (which could
  be MitM'ed)
- it's inherently dangerous, and the more it protects you the more dangerous it
  becomes (e.g., a longer expiry time means if something goes wrong, the longer
  your domain will be bricked)
- what it actually protects you from is a very rare event that's quite risky for
  the attacker anyway (thus the reward of deploying HPKP is very small compared
  to the risks)
- without it, you may be vulnerable to a sophisticated, state-level attacker,
  who is willing to burn their compromised CA just to attack your website
  (but this is highly unlikely and should be balanced against the cost of
  deployment for the data that is being secured);
- it can be used to track users


Not Worth it in Most Cases
--------------------------

The data's security isn't intended to defend against state-level actors and as
such the risks involved with HPKP are not worth the minor benefits. Said
differently, if you're not Google, a bank, a hospital, or the government, it's
likely not really doing anything for you. Plus, the NSA can probably compromise
you through sidechannels anyway.

I don't believe anything I'm building is going to be the target of such a
sophisticated attacker and as such I don't think this particular technology is
useful in most cases. Similarly, I'm also not encrypting with post-quantum
algorithms to defend against quantum computer attacks, nor am I paying for
server space that is physically secured by military personel. These are
decisions which make my systems *less* secure (overall) but secure *enough* for
my goals. In the end, there is no such thing as "100% secure" and as such there
is always a trade off to be made. This is one of those things that needs to be
decided when you ask yourself the question "what are we trying to secure and
why?". imho, HPKP should only be considered for "very high priority" needs,
which, in my experience, is not something I personally work on.

Just because a thing exists doesn't mean that thing must always be used.

If I absolutely *had* to deploy HPKP, I'd do so as "reporting-only"
(i.e., Public-Key-Pins-Report-Only), but even then you'd need to setup a
reporting endpoint, have a human monitor it and take action when needed, and
have processes in place to handle events when they happen (i.e., a lot of
effort and cost).


Recommendations
---------------

- do not use HPKP (unless you understand why you need it)
- use HSTS
- use CSP
- use XSS protection
- use Frame-Options (deny)
- use nosniff


Further Reading
---------------

- https://blog.qualys.com/ssllabs/2016/09/06/is-http-public-key-pinning-dead
- https://blog.appcanary.com/2017/http-security-headers.html
- https://utcc.utoronto.ca/~cks/space/blog/web/WhyNotHTTPKeyPinning
- https://www.smashingmagazine.com/be-afraid-of-public-key-pinning/

