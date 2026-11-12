/**
 * Model registry: maps opencode providers/models onto OpenAI model ids.
 *
 * opencode model ids are `provider/model` (e.g. `opencode/glm-5.3-flash-free`).
 * Clients may use either the fully qualified id or the bare model id; both are
 * accepted and resolved back to the provider/model pair.
 *
 * The opencode catalogue holds ~9 000 models and its raw JSON is ~7 MB. The
 * registry therefore keeps a compact projection of it — plain strings instead
 * of the full model objects — which costs a fraction of the heap.
 */

export class ModelRegistry {
  constructor() {
    /** @type {Map<string, {name: string, connected: boolean, models: string[]}>} */
    this.providers = new Map()
    /** @type {Map<string, string>} bare model id -> fully qualified id */
    this.bareIndex = new Map()
    this.modelCount = 0
    this.loadedAt = 0
    this.ttl = 60_000
  }

  /**
   * Rebuilds the registry from the opencode provider catalogue.
   * @param {{all: any[], default?: Record<string,string>, connected?: string[]}} payload
   */
  update(payload) {
    // Build into fresh maps and swap them in, so a reader never sees the
    // registry half-rebuilt.
    const providers = new Map()
    const bareIndex = new Map()
    let modelCount = 0

    const connected = new Set(payload.connected ?? [])

    for (const provider of payload.all ?? []) {
      const providerID = provider.id
      const models = Object.keys(provider.models ?? {})
      if (!models.length) continue

      providers.set(providerID, {
        name: provider.name ?? providerID,
        connected: connected.has(providerID),
        models,
      })
      modelCount += models.length

      for (const modelID of models) {
        // First provider wins for a bare model id; connected providers are
        // preferred by #lookup().
        if (!bareIndex.has(modelID)) bareIndex.set(modelID, `${providerID}/${modelID}`)
      }
    }

    this.providers = providers
    this.bareIndex = bareIndex
    this.modelCount = modelCount
    this.loadedAt = Date.now()
  }

  isStale() {
    return Date.now() - this.loadedAt > this.ttl
  }

  /** Number of models in the catalogue. */
  get size() {
    return this.modelCount
  }

  /**
   * Resolves a client-supplied model id to {providerID, modelID, id}.
   *
   * A `#variant` suffix is supported (opencode's own convention), e.g.
   * `anthropic/claude-sonnet-4-6#high`.
   */
  resolve(requested) {
    if (!requested) return undefined

    let name = requested
    let variant
    const hash = name.lastIndexOf("#")
    if (hash > 0) {
      variant = name.slice(hash + 1)
      name = name.slice(0, hash)
    }

    const entry = this.#lookup(name)
    if (!entry) return undefined
    return variant ? { ...entry, variant } : entry
  }

  #lookup(requested) {
    // Fully qualified id: `provider/model`.
    const slash = requested.indexOf("/")
    if (slash > 0) {
      const providerID = requested.slice(0, slash)
      const provider = this.providers.get(providerID)
      const modelID = requested.slice(slash + 1)
      if (!provider || !provider.models.includes(modelID)) return undefined
      return {
        id: requested,
        providerID,
        modelID,
        name: provider.name,
        ownedBy: provider.name,
        connected: provider.connected,
      }
    }

    // Bare model id: prefer a provider the user has connected.
    const qualified = this.bareIndex.get(requested)
    if (!qualified) return undefined

    const qualifiedSlash = qualified.indexOf("/")
    const providerID = qualified.slice(0, qualifiedSlash)
    const provider = this.providers.get(providerID)
    if (!provider) return undefined

    if (!provider.connected) {
      for (const [id, entry] of this.providers) {
        if (entry.connected && entry.models.includes(requested)) {
          return {
            id: `${id}/${requested}`,
            providerID: id,
            modelID: requested,
            name: entry.name,
            ownedBy: entry.name,
            connected: true,
          }
        }
      }
    }

    return {
      id: qualified,
      providerID,
      modelID: requested,
      name: provider.name,
      ownedBy: provider.name,
      connected: provider.connected,
    }
  }

  /** OpenAI /v1/models payload. */
  list(owner) {
    const created = Math.floor(this.loadedAt / 1000)
    const data = []

    for (const [providerID, provider] of this.providers) {
      const ownedBy = provider.connected ? owner : `${owner}:${providerID}`
      for (const modelID of provider.models) {
        data.push({
          id: `${providerID}/${modelID}`,
          object: "model",
          created,
          owned_by: ownedBy,
        })
      }
    }

    return { object: "list", data }
  }
}
