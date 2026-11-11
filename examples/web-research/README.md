# web-research

Answer a question from the web and cite the pages it read. The example hands
`web_tools(...)` from `fascicle/web` to one `generate` call, and the model
does the rest: it searches, fetches the pages that look useful, and writes an
answer that ends with the URLs it leaned on.

This is the real network with a real model. Each tool call prints as it
happens (the query for a search, the URL for a fetch and how many characters
came back), so you can watch what the model went looking for before you read
what it concluded.

## Flow

```text
engine            openrouter, openai/gpt-4o-mini by default
└─ generate       the one call, with the tool loop inside it
   ├─ web_search  the model asks with a query and gets titles, URLs, snippets
   ├─ web_fetch   the model asks for a URL and gets the page back as text
   ├─ ...         more searches and fetches, until a turn calls no tool
   └─ output      the answer and its sources, 12 turns max
```

## Run

Prereq: `OPENROUTER_API_KEY` exported, or set in the root `.env` (see
`.env.example`).

```bash
pnpm exec tsx --env-file=.env examples/web-research/main.ts
pnpm exec tsx --env-file=.env examples/web-research/main.ts "What changed in the latest Node release?"
```

That's all it needs. With no other variable set, the search is Wikipedia, so
ask it something an encyclopedia would know.

## Which Search It Uses

`web_fetch` works on its own, but `web_search` needs an index to ask, and
Fascicle doesn't ship one. You pass it a search function. The example always
has one, and it picks the first of three that your environment allows:

| Set | Search |
| --- | --- |
| `BRAVE_API_KEY` | `brave_search`, Brave's Search API |
| `SEARXNG_URL` | `searxng_search`, a SearXNG server that you run yourself |
| neither | the Wikipedia search in [`wikipedia_search.ts`](./wikipedia_search.ts) |

The first line on stderr says which one it took.

```bash
SEARXNG_URL=http://localhost:8888 pnpm exec tsx --env-file=.env examples/web-research/main.ts "What changed in the latest Node release?"
```

The Wikipedia search lives in the example and not in `fascicle/web`, because
one encyclopedia isn't the web. It's here for two reasons. It lets the
example run with nothing but a model key, and it shows what a search of your
own looks like. A `WebSearch` is a function that takes `{ query, limit }` and
returns a list of `{ title, url, snippet }`, and the file is about that long.
If you have an index (your docs, your tickets, your wiki), that's the shape
to copy.

## SearXNG in a Container

SearXNG is a search server you run yourself, with no key and no account. It
answers in HTML until you turn JSON on, so starting it takes two steps.

```bash
docker run --name searxng -d -p 8888:8080 -v "./config/:/etc/searxng/" docker.io/searxng/searxng:latest
```

The first start writes `./config/settings.yml`, a short file that takes every
default. Open it and add this block, which keeps HTML and turns JSON on:

```yaml
search:
  formats:
    - html
    - json
```

Then `docker restart searxng`, and run the example with
`SEARXNG_URL=http://localhost:8888`. If you skip the edit the server answers
403, and the error that `searxng_search` throws tells you to go back and make
it.

## Keep It to a Few Hosts

`--allow-host` narrows `web_fetch` to the hosts you name. You can repeat it,
and a name covers its subdomains, so `wikipedia.org` covers
`en.wikipedia.org`.

```bash
pnpm exec tsx --env-file=.env examples/web-research/main.ts \
  --allow-host wikipedia.org --allow-host nodejs.org \
  "Who designed the Sydney Opera House?"
```

A fetch to any other host is refused before a connection opens. The refusal
goes back to the model as the tool's result, which is why you'll see a line
for it in the output and then see the model pick another page.

This matters more than it looks. A page that the model reads is text that
somebody else wrote, and that text can try to talk the model into fetching
an address of the author's choosing. `web_fetch` already refuses loopback,
private, and link-local addresses, which keeps a page from steering the model
at your own network. A short list of hosts closes the rest of that door. The
[system prompt](./prompts/system.md) does its part too. It tells the model
that a page is material to read and never instructions to follow, but a
prompt is a request and the list is a rule, so use the list when it counts.

## Next to `researcher`

[`examples/researcher/`](../researcher/) looks similar and proves something
different. It checks the shape of an agent (rounds, a summarizer, a guard)
against mock `search` and `fetch` functions, with no network and no key.
This one has no shape to speak of. It's one model call, and what it proves is
that the tools reach the real web.

The two fit together. To put that agent on the real web, give it a `search`
that calls an adapter such as `brave_search({ api_key })` with the query, and
a `fetch` that calls the `execute` of the `web_fetch` tool with the URL.
