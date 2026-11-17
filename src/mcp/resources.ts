/**
 * Inbound MCP resources: list, read, and watch what a server publishes, as
 * plain Fascicle-owned shapes.
 *
 * Each call is a thin translation of one SDK call. The one piece of state is
 * the set of callbacks waiting on each URI, which is what lets several
 * subscribers share one subscription on the wire.
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { mcp_error } from './errors.js'
import { load_client_sdk } from './sdk_loader.js'

export type McpResource = {
  uri: string
  name: string
  description?: string
  mime_type?: string
}

export type McpResourceTemplate = {
  // An RFC 6570 template, such as `file:///{path}`.
  uri_template: string
  name: string
  description?: string
  mime_type?: string
}

/** One part of a resource's content: `text` as written, or `blob` in base64. */
export type McpResourceContent = {
  uri: string
  mime_type?: string
} & ({ text: string } | { blob: string })

export type McpResources = {
  /** Every resource the server lists, across all of its pages. */
  readonly list: () => Promise<McpResource[]>
  /** Every resource template the server lists, across all of its pages. */
  readonly templates: () => Promise<McpResourceTemplate[]>
  readonly read: (uri: string) => Promise<McpResourceContent[]>
  /**
   * Calls `on_update` with the URI each time the server says the resource
   * changed. The notification carries no content, so reading the resource
   * again is the callback's choice. Subscribers to one URI share a single
   * subscription on the server.
   */
  readonly subscribe: (uri: string, on_update: (uri: string) => void) => Promise<void>
  /** Drops every callback on the URI and ends the server's subscription. */
  readonly unsubscribe: (uri: string) => Promise<void>
  /** Calls `on_change` each time the server says its list of resources changed. */
  readonly on_list_changed: (on_change: () => void) => Promise<void>
}

type Subscription = {
  callbacks: Set<(uri: string) => void>
  // Settles when the server has answered the `resources/subscribe` request.
  ready: Promise<void>
}

type Feature = 'resources' | 'subscribe' | 'listChanged'

const REMEDIES: Record<Feature, string> = {
  resources: 'connect to a server that lists `resources` among its capabilities',
  subscribe: 'call resources.read when you need the current content',
  listChanged: 'call resources.list when you need the current listing',
}

/**
 * Builds the `resources` namespace of an `mcp_client` handle over a connected
 * client.
 *
 * Nothing is registered on the client until the first `subscribe` or
 * `on_list_changed`, so a caller who only wants tools pays nothing for this.
 * Every failed request goes through `translate`, which is how an expired
 * token on an HTTP connection reads the same here as it does on a tool call.
 */
export function create_resources(
  client: Client,
  translate: (err: unknown) => unknown,
): McpResources {
  const subscriptions = new Map<string, Subscription>()
  const list_listeners = new Set<() => void>()
  let update_handler: Promise<void> | undefined
  let list_handler: Promise<void> | undefined

  const request = async <t>(send: () => Promise<t>): Promise<t> =>
    send().catch((err: unknown) => {
      throw translate(err)
    })

  const listen_for_updates = async (): Promise<void> => {
    update_handler ??= load_client_sdk().then((sdk) => {
      client.setNotificationHandler(sdk.ResourceUpdatedNotificationSchema, (notification) => {
        const uri = notification.params.uri
        notify_all(subscriptions.get(uri)?.callbacks ?? [], (on_update) => on_update(uri))
      })
    })
    return update_handler
  }

  const listen_for_list_changes = async (): Promise<void> => {
    list_handler ??= load_client_sdk().then((sdk) => {
      client.setNotificationHandler(sdk.ResourceListChangedNotificationSchema, () => {
        notify_all(list_listeners, (on_change) => on_change())
      })
    })
    return list_handler
  }

  return {
    list: async () => {
      require_capability(client, 'resources', 'resources.list')
      const found: McpResource[] = []
      let cursor: string | undefined
      do {
        const params = cursor !== undefined ? { cursor } : undefined
        const page = await request(() => client.listResources(params))
        for (const resource of page.resources) {
          found.push({ uri: resource.uri, name: resource.name, ...described(resource) })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return found
    },

    templates: async () => {
      require_capability(client, 'resources', 'resources.templates')
      const found: McpResourceTemplate[] = []
      let cursor: string | undefined
      do {
        const params = cursor !== undefined ? { cursor } : undefined
        const page = await request(() => client.listResourceTemplates(params))
        for (const template of page.resourceTemplates) {
          found.push({ uri_template: template.uriTemplate, name: template.name, ...described(template) })
        }
        cursor = page.nextCursor
      } while (cursor !== undefined)
      return found
    },

    read: async (uri) => {
      require_capability(client, 'resources', 'resources.read')
      const result = await request(() => client.readResource({ uri }))
      return result.contents.map((part) => ({
        uri: part.uri,
        ...(part.mimeType !== undefined ? { mime_type: part.mimeType } : {}),
        ...('text' in part ? { text: part.text } : { blob: part.blob }),
      }))
    },

    subscribe: async (uri, on_update) => {
      require_capability(client, 'subscribe', 'resources.subscribe')
      await listen_for_updates()
      const existing = subscriptions.get(uri)
      if (existing !== undefined) {
        existing.callbacks.add(on_update)
        return existing.ready
      }
      const subscription: Subscription = {
        callbacks: new Set([on_update]),
        ready: request(async () => {
          await client.subscribeResource({ uri })
        }),
      }
      // In place before the server answers, so an update that arrives ahead
      // of the answer still reaches the callback.
      subscriptions.set(uri, subscription)
      return subscription.ready.catch((err: unknown) => {
        // A later subscribe may have replaced this entry already.
        if (subscriptions.get(uri) === subscription) subscriptions.delete(uri)
        throw err
      })
    },

    unsubscribe: async (uri) => {
      if (!subscriptions.delete(uri)) return
      await request(() => client.unsubscribeResource({ uri }))
    },

    on_list_changed: async (on_change) => {
      require_capability(client, 'listChanged', 'resources.on_list_changed')
      await listen_for_list_changes()
      list_listeners.add(on_change)
    },
  }
}

/**
 * Throws `mcp_error` when the server's handshake left out the capability a
 * resources call depends on.
 *
 * The SDK sends the request regardless, and the server's refusal comes back
 * as a bare JSON-RPC error (or, for a list-changed listener, as silence), so
 * the check happens here where the message can say what is missing. A session
 * rejoined by `session_id` skipped the handshake and has no capabilities to
 * read, so its requests go to the server unchecked.
 */
function require_capability(client: Client, feature: Feature, action: string): void {
  const capabilities = client.getServerCapabilities()
  if (capabilities === undefined) return
  const resources = capabilities.resources
  if (resources === undefined) {
    throw new mcp_error(
      `MCP server does not advertise the \`resources\` capability, so ${action} has nothing to ask it: ${REMEDIES.resources}`,
    )
  }
  if (feature === 'resources' || resources[feature] === true) return
  throw new mcp_error(
    `MCP server does not advertise the \`resources.${feature}\` capability, so ${action} would never hear from it: ${REMEDIES[feature]}`,
  )
}

/**
 * The optional fields a resource and a resource template share, under
 * Fascicle's names and absent when the server sent none.
 */
function described(entry: {
  description?: string | undefined
  mimeType?: string | undefined
}): { description?: string; mime_type?: string } {
  return {
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.mimeType !== undefined ? { mime_type: entry.mimeType } : {}),
  }
}

/**
 * Calls every callback, then rethrows the first failure.
 *
 * One subscriber that throws does not keep the rest from hearing the
 * notification. The rethrown failure lands in the SDK's notification
 * dispatch, which hands it to the client's `onerror`.
 */
function notify_all<f>(callbacks: Iterable<f>, call: (callback: f) => void): void {
  const failures: unknown[] = []
  for (const callback of callbacks) {
    try {
      call(callback)
    } catch (err: unknown) {
      failures.push(err)
    }
  }
  if (failures.length > 0) throw failures[0]
}
