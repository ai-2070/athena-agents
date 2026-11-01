# Venice API support

1 November 2026. Proposed implementation; no runtime changes yet.

Add Venice as a named API provider for agents and the Brain. Reuse the `openai` engine and existing
tool approvals, chat storage, streaming and compaction. Users should be able to save and test a Venice
key, choose a Venice model, use it in teams, and see its balance and run costs as they can with OpenRouter.

## Scope and design choices

- Store agents as `engine: 'openai', provider: 'venice'`. Keep `EngineId` unchanged.
- Use the fixed base URL `https://api.venice.ai/api/v1` with server-side Bearer authentication, as
  documented in the [API reference](https://docs.venice.ai/api-reference/api-spec).
- Include Settings, the model picker and favorites, agent creation, the Agent library, Brain model
  selection, Brain model-management actions, status displays, balances and run accounting.
- Add `defaults.veniceModel`, initially empty. Users select a model explicitly or set this default.
  An empty Venice model must never fall through to `defaults.openrouterModel`.
- Disable Venice's added system prompt with `venice_parameters.include_venice_system_prompt: false`
  so Athena's agent and Brain instructions remain authoritative. This is a proposed integration default;
  the parameter is described in the [API reference](https://docs.venice.ai/api-reference/api-spec).
- Keep Venice search, scraping and character features off. Native image, audio, video, embeddings,
  wallet authentication and TEE/E2EE verification are separate work. Existing image attachments remain
  available on compatible chat models.
- Claude Code's OpenRouter authentication option is a separate integration. Do not add Venice to
  `ClaudeAuth` in this change; native Venice support here runs through the API engine.
- Add no SDK dependency. Keep provider differences in small helpers rather than creating another engine.

## Existing code that needs attention

| Area | Current coupling | Planned change |
| --- | --- | --- |
| `shared/types.ts`, `server/store.ts` | Provider, Brain, secret, status and usage unions name OpenRouter; defaults contain one hosted API model | Add Venice and its own default, with additive settings merging |
| `server/engines/openai.ts` | Provider registry is reusable; missing-key text and model fallback name OpenRouter | Register Venice; make setup errors and defaults provider-aware |
| `server/engines/openai.ts` model listing | Reads OpenRouter's top-level metadata and assumes other providers support tools | Normalize Venice metadata explicitly |
| `server/models.ts`, `server/overseer.ts` | Provider readiness, defaults, model lookup, switching and prompt instructions enumerate providers | Add Venice throughout model management |
| `server/brain.ts` | Brain selection and its own HTTP completion path are OpenRouter-specific | Share provider request helpers and support Venice in both completion modes |
| `web/models.tsx` | The `openai` tab means OpenRouter; Brain conversion maps every API choice to OpenRouter | Give Venice a distinct picker tab and preserve provider identity |
| `web/agentstats.ts` | Most API agents are counted and labeled as OpenRouter | Count and label Venice independently |
| `server/status.ts`, `server/index.ts` | Hosted balance retrieval uses OpenRouter's endpoints | Add Venice balance retrieval through its inference-key-compatible endpoint |

## 1. Provider types, secrets and defaults

Update `ProviderId`, `SecretKey`, `BrainSetting.provider`, `EngineStatus.openai` and `ProviderUsage.id`
in `shared/types.ts`. Add `veniceKey`, `defaults.veniceModel` and any shared response types needed by
the key test, model metadata and billing display.

Extend the secret-status list in `server/store.ts` and the `/api/secrets` allowlist in `server/index.ts`.
Use the existing secret store and settings events. Return only key presence and the existing masked
hint to the browser. Exercise the existing backup and project-sync exclusions with a Venice sentinel key.

Register Venice in `PROVIDERS` and `MODEL_PROVIDERS`. Extend readiness checks, `readyProviders()`,
`defaultModelFor()` and Brain provider availability. A configured key means setup is present; it does
not mean a remote validation request has succeeded.

Make default-model resolution accept the API provider and use the same rule wherever defaults are
resolved: `server/engines/openai.ts`, `server/engines/index.ts`, `server/compaction.ts`,
`server/library.ts`, `server/overseer.ts`, `web/views/agents.tsx`, `web/views/library.tsx` and
`web/agentstats.ts`. Share the pure resolution logic where practical. Preserve the existing OpenRouter
behavior for old agents with no provider. An unconfigured Venice default produces a clear request to
choose a model. Switching providers clears an incompatible model or selects the destination default.

## 2. Key validation and balances

Add `POST /api/settings/test-venice`. Validate the saved key using authenticated
`GET /api_keys/rate_limits`; this endpoint returns access, expiration, balances and model rate limits.
It accepts inference keys, unlike admin-only account endpoints. Model discovery is public and cannot
serve as a key test. See [authentication](https://docs.venice.ai/api-reference/api-spec) and
[rate limits and balances](https://docs.venice.ai/api-reference/endpoint/api_keys/rate_limits).

Normalize the response into a small shared result rather than returning the upstream body unchanged.
Distinguish a valid key from blocked access, expiration or insufficient funds. Apply a timeout and
normalize both string and object error bodies. The test must not generate a paid completion.

Reuse this reader for `server/status.ts` balance polling and the existing provider-usage response in
`server/index.ts`. Display USD, DIEM and bundled credits as distinct available values; do not invent a
spent percentage or today's spend. Cache results briefly, invalidate on key replacement/removal, and
prevent an old in-flight response from repopulating the cache after the key changes. A failed balance
request must not break the rest of the status response.

## 3. Model discovery and capabilities

Request `/models?type=text`. Add a Venice response normalizer with narrowed optional fields, leaving
the existing OpenRouter and local-server mappings intact. The [model endpoint](https://docs.venice.ai/api-reference/endpoint/models/list)
places metadata under `model_spec`:

| Venice field | Athena use |
| --- | --- |
| `id`, `model_spec.name` | Model identifier and display name |
| `model_spec.availableContextTokens` | Picker context and compaction window |
| `model_spec.capabilities.supportsFunctionCalling` | Tool-use availability |
| `model_spec.capabilities.supportsVision`, `supportsMultipleImages` | Image attachment behavior |
| `model_spec.capabilities.supportsReasoningEffort`, `reasoningEffortOptions` | Effort control and request validation |
| `model_spec.pricing.input.usd`, `output.usd` | Catalog prices for input and output |
| `model_spec.offline` | Mark unavailable models and exclude them from new default choices |

Venice text prices are already quoted per million tokens; do not apply OpenRouter's per-token
multiplier. See [pricing](https://docs.venice.ai/overview/pricing).

Put the normalized API model shape in `shared/types.ts` and use it in the engine and browser listing
instead of adding another divergent shape. Capability fields must be optional so old providers and
incomplete responses retain their existing behavior. Treat missing prices as unknown, preserving zero
prices when explicitly returned. Validate HTTP status and numeric fields before accepting a catalog.

Carry this metadata through model search and `find_models`, including the no-tool-use note for Venice.
Allow catalog browsing before setup, but keep inference readiness dependent on the key. Make catalog
failures and empty results visible in the picker and provide manual model entry; do not show fabricated
OpenRouter picks under Venice. Preserve favorites and currently selected models during refresh failures.

## 4. API execution, effort and accounting

Extract small helpers for provider configuration, error decoding, request options and model defaults
so agent runs and the Brain agree. Send Venice requests to `/chat/completions` with
`stream_options.include_usage: true`. Keep OpenRouter referral headers, `usage.include`, `session_id`
and cache-control conventions scoped to OpenRouter. Venice's request and response fields are documented
in [chat completions](https://docs.venice.ai/api-reference/endpoint/chat/completions).

Use `reasoning_effort` for Venice and derive accepted levels from each model's advertised options.
Update `shared/effort.ts` and the picker to support a model-specific subset; the current contiguous
provider-level range cannot express every subset. Hide effort for models explicitly lacking support;
omit it if metadata is unavailable. Keep the existing UI's effort vocabulary; do not add a new `none`
setting in this change. Venice documents variable options and separate `reasoning_content` in its
[reasoning guide](https://docs.venice.ai/guides/features/reasoning-models). Do not concatenate reasoning
into final answer text. Full reasoning display is separate work.

Use known tool and vision capabilities before sending unsupported request fields. Preserve the current
fallback for unknown capabilities. For text-only models, retain the existing attachment note behavior;
respect single-image limits where advertised. Keep all built-in and MCP tool execution on the current
approval path, with the existing Stop, step-limit and project ownership behavior.

Normalize Venice errors shaped as either `{ error: string }` or `{ error: { message, ... } }` for HTTP
and streamed failures. Preserve status information for auth/access errors, payment errors, invalid
models, throttling and overflow. Do not retry after emitted content or tool-call fragments, and do not
silently switch providers on a runtime failure. See [error codes](https://docs.venice.ai/api-reference/error-codes).

Account for Venice's top-level `cost: { usd, diem }`, independently of `usage` token counts. The current
engine reads only `usage.cost`, which would miss that cost. Confirm the terminal SSE cost envelope with
a captured fixture during implementation; the documented non-streamed response does not establish its
exact streamed placement. Accumulate one final usage/cost record per completion, avoiding double-counted
snapshots. Preserve OpenRouter accounting. See [chat completions](https://docs.venice.ai/api-reference/endpoint/chat/completions).

Keep reported currency charges distinct from a USD-equivalent estimate used for the existing run
budget. If reported USD billing is absent or DIEM funds the run, estimate USD-equivalent token cost
from available catalog rates and label it as estimated; do not present it as a USD debit or call it free.
Carry optional billing/source metadata in shared types through saved run usage and the chat display.
If rates and reported cost are both unavailable, show cost as unavailable and explain that the monetary
stop cannot be measured for that run. Keep the step limit active. Apply the existing budget check before
another model step; document that it is a between-step stop and cannot cap one in-flight completion.

Use automatic provider caching initially. Venice's `prompt_cache_key` can be added later without
reusing OpenRouter's `session_id`; see [prompt caching](https://docs.venice.ai/guides/features/prompt-caching).

## 5. Brain and user interface

In `server/brain.ts`, extend `brainModel()` and its engine/default/availability maps, then add Venice
to `think()` for both streamed and non-streamed requests. Pass the actual provider to effort handling.
Use ordinary Athena system messages for Venice, preserving OpenRouter's specialized cache formatting.
Keep cut-off-answer detection and JSON parsing behavior. A Venice Brain selection requires an explicit
model or configured Venice default. Retain the existing setup-time fallback policy and report the
effective provider through the existing fallback indicator; append Venice to fallback discovery without
changing the order of existing choices.

In `server/overseer.ts`, update provider instructions, readiness, `find_models`, `set_model`, model
preparation and agent/team switching. Other Brain features using `think()` then gain Venice through
that common path, including routing, agent design, reviews and non-instant compaction summaries.

In `web/models.tsx`, distinguish picker tab identity from engine identity. Add a Venice tab that emits
`{ engine: 'openai', provider: 'venice', model }`. Correct Brain-to-agent and agent-to-Brain conversion
so API provider identity survives selection, reopening, favorites and effort-only edits. Permit both
hosted API providers in the Brain picker while retaining the current exclusion of local servers.

Update these surfaces using existing controls, theme tokens and a neutral glyph if no Venice mark exists:

- `web/views/settings.tsx`: Venice key save/remove/test, a link to Venice API settings, default-model
  selection, Brain copy and cost-limit wording. Keep balance details separate from test success.
- `web/views/agents.tsx`, `web/views/library.tsx`: provider choice and correct creation/switching defaults.
- `web/views/setup.tsx`, `web/views/home.tsx`: setup search terms and readiness guidance.
- `web/models.tsx`, `web/agentstats.ts`, `web/app.ts`: Venice model labels, provider status, Brain labels,
  favorites, and Station counts. Audit Station consumers of the engine-name and grouping helpers.
- Existing chat usage and provider-balance displays: billing source, estimates and currency labels.

Update README and `docs/guide.md` with key setup, model selection, Brain support, capability differences,
balance units and budget behavior. Keep private-inference claims within what this integration implements.

## 6. Verification and delivery

Add tests with each implementation step. Mock Venice HTTP responses or use a local fixture server;
automated tests must use the existing isolated data setup and require no real key or paid calls.

| Coverage | Existing files to extend or nearby new tests |
| --- | --- |
| Additive settings, secret masking/removal, API allowlist and backup exclusions | `tests/server/store.test.ts`, `api.test.ts`, `backup.test.ts`, `projectsync.test.ts` |
| Public catalog versus authenticated key test; invalid/expired/restricted key; balance cache invalidation | New provider tests beside `tests/server/openai-engine.test.ts`; API and status tests |
| Metadata normalization, missing fields, offline/non-text models, zero prices and price units | New provider model tests; `tests/server/brain-models.test.ts` |
| Provider-specific defaults, old agent compatibility, Venice-only setup, Brain search/switching and team actions | `tests/server/brain-models.test.ts`, `groupB-overseer.test.ts`, library tests |
| SSE fragments, tool round trips, Stop, string/object errors, overflow, effort options, image limits, terminal usage/cost and budget stops | `tests/server/openai-engine.test.ts`, `effort.test.ts`, `compaction.test.ts`, `promptcache.test.ts` |
| Brain streamed/non-streamed requests, provider selection/fallback, system prompt options and cut-off responses | `tests/server/brain-stream.test.ts`, `brain-chat.test.ts` and a focused Brain-provider test |
| Key controls, picker tabs, favorites, Brain conversion, effort edits, defaults, labels and Station counts | `tests/web/models.test.ts`, `agent-effort.test.ts`, `agents-page.test.tsx`, `settings-general.test.tsx`, `agentstats.test.ts` |

Update typed test fixtures that construct complete `Settings`, `SecretStatus` or `EngineStatus` objects.
Assert OpenRouter request headers, caching and model defaults remain unchanged. Assert Venice keys are
never forwarded to OpenRouter or included in settings responses, backups or project folders.

Deliver in this order: provider types/secrets/defaults; model normalization and key/balance reader;
agent execution/accounting; Brain and picker integration; remaining UI/docs and regression checks.
Land tests alongside each part rather than postponing them to the last change.

Before calling the implementation done, run `bun run check`, `bun run build`, desktop staging and
`bun run desktop:smoke`. CI must pass on Windows and Linux. With a test key available, make a small
manual streamed chat, one tool round trip, a supported image request and a Brain request; verify the
streamed accounting fixture against the real response. Live checks are separate from automated tests.

Acceptance: a user with only a Venice key can test setup, select a catalog model, run an agent and team,
set the Brain to Venice, and reopen the app with those choices intact. Model identity, context, effort,
tool capability, balance and cost labels remain correct throughout. Removing the key removes readiness
and cached account information. Existing projects continue using their current providers and defaults.
