// Types shared by the server (server/) and the browser app (web/).
// The server stores these as JSON files; the browser gets them from the API.
import type { Effort } from './effort.ts';
import type { SerializedMessage } from 'chat';
import type { UIMessageChunk } from 'ai';
export type { Effort } from './effort.ts';

/** A run or the Brain's answer as it streams: Vercel AI SDK UI message chunks, sent as oRPC events
 *  (server/uistream.ts), read by the chat views with the AI SDK (web/chat/transport.ts). */
export type UIStream = AsyncIteratorObject<UIMessageChunk, unknown, void>;

export type EngineId = 'claude-code' | 'eve' | 'hermes' | 'codex' | 'pi' | 'omp' | 'openclaw' | 'opencode';
export type Autonomy = 'ask' | 'auto' | 'full';
export type ProviderId = 'openrouter' | 'venice' | 'lmstudio' | 'ollama' | 'custom';

// ---------- chat gateway instances ----------
export type GatewayPlatform = 'telegram' | 'slack' | 'discord' | 'whatsapp';
export type GatewayTarget = { kind: 'brain' } | { kind: 'team'; id: string } | { kind: 'agent'; id: string };
export interface GatewayTargets {
  agents: { id: string; name: string }[];
  teams: { id: string; name: string }[];
}

export type GatewaySenderPolicy =
  | { platform: 'telegram'; allowedUserIds: string[] }
  | { platform: 'whatsapp'; allowedPhones: string[] }
  | { platform: 'slack' | 'discord'; allowedUserIds: string[] };

/** Versioned protocol for the separate hosted WhatsApp relay. Not part of dashboard state. */
export interface GatewayWhatsAppRelayLimits {
  bodyBytes: number;
  queueBytes: number;
  queueEvents: number;
  replayEntries: number;
  retentionMs: number;
  replayMs: number;
  pairingMs: number;
  leaseMs: number;
  batchBytes: number;
  batchEvents: number;
}
export interface GatewayWhatsAppRelayEnvelope {
  sequence: number;
  id: string;
  receivedAt: number;
  expiresAt: number;
  bodyBase64: string;
  signature: string;
  contentType: string;
}
export interface GatewayWhatsAppRelayStatus {
  version: 1;
  installationId: string;
  businessAccountId: string;
  phoneNumberId: string;
  epoch: string;
  cursor: number;
  gap: { at: number; through: number } | null;
  limits: GatewayWhatsAppRelayLimits;
  queuedEvents: number;
  queuedBytes: number;
}
/** Private Durable Object metadata; plaintext pairing, client and lease keys are never stored. */
export interface GatewayWhatsAppRelayState {
  version: 1;
  installationId: string;
  businessAccountId: string;
  phoneNumberId: string;
  epoch: string;
  nextSequence: number;
  cursor: number;
  lastAckId: string | null;
  lastReceivedAt: number;
  lostThrough: number;
  gapAt: number | null;
  tokenHash: string | null;
  pairingHash: string | null;
  pairingExpiresAt: number;
  leaseHash: string | null;
  leaseConsumer: string | null;
  leaseExpiresAt: number;
  deliveredThrough: number;
}

/** Browser-safe configuration. Credentials are stored separately and never included here. */
export interface GatewayInstance {
  id: string;
  name: string;
  platform: GatewayPlatform;
  accountId: string;
  projectId: string;
  target: GatewayTarget;
  senderPolicy: GatewaySenderPolicy;
  scope: { directMessages: boolean; conversationIds: string[]; guildIds: string[] };
  fileLimits: { perFileBytes: number; perMessageBytes: number; filesPerMessage: number; dailyBytes: number };
  enabled: boolean;
  routeGeneration: number;
  createdAt: number;
  updatedAt: number;
}

/** A connection as the Gateways page lists it: who it answers as, and which of its secrets are saved. */
export type GatewayListing = GatewayInstance & { targetName: string; credentials: Record<string, boolean> };

/** Removing an instance keeps its identity and receipts, never its credentials. */
export interface GatewayRetiredInstance {
  version: 1;
  id: string;
  name: string;
  platform: GatewayPlatform;
  accountId: string;
  projectId: string;
  target: GatewayTarget;
  routeGeneration: number;
  startedAt: number;
  completedAt?: number;
}

/** Queued work keeps this route even when the instance is edited. */
export interface GatewayRoute {
  instanceId: string;
  projectId: string;
  target: GatewayTarget;
  generation: number;
}

/** Private SDK coordination state, separate from the application inbox and delivery ledgers. */
export interface GatewaySdkState {
  version: 1;
  values: Record<string, { value: unknown; expiresAt: number | null }>;
  lists: Record<string, { values: unknown[]; expiresAt: number | null }>;
  locks: Record<string, { threadId: string; token: string; expiresAt: number }>;
  subscriptions: string[];
  queues: Record<string, { enqueuedAt: number; expiresAt: number; message: SerializedMessage }[]>;
}

/** Private Discord resume state. Never returned by the instance API. */
export interface GatewayDiscordState {
  version: 1;
  accountId: string;
  intents: number;
  identifiedAt?: number;
  retryAt?: number;
  session?: { id: string; url: string; sequence: number };
  gap?: { at: number; reason: 'session-lost' };
  reviewedGaps?: { at: number; gapAt: number; sequence: number; revision: string }[];
}

/** Safe recovery preview; session IDs and resume addresses stay private. */
export interface GatewayDiscordRecovery {
  gap: { at: number; revision: string } | null;
}

export interface GatewayInbound {
  platform: GatewayPlatform;
  accountId: string;
  conversationId: string;
  guildId?: string;
  parentConversationId?: string;
  threadId: string;
  sourceEventId: string;
  sourceMessageId: string;
  sentAt?: number;
  whatsappUserId?: string;
  kind: 'message' | 'edit';
  actor: { id: string; label: string; kind: 'user' | 'bot' | 'anonymous' };
  directMessage: boolean;
  triggered: boolean;
  mediaGroupId?: string;
  text: string;
  media: {
    kind: 'image' | 'file' | 'audio' | 'video';
    fileId: string;
    name?: string;
    mimeType?: string;
    size?: number;
    sha256?: string;
  }[];
}

export interface GatewayConversationBinding {
  id: string;
  rootId?: string;
  accountId: string;
  conversationId: string;
  guildId?: string;
  parentConversationId?: string;
  threadId: string;
  route: GatewayRoute;
  createdAt: number;
}

export interface GatewayInboxEvent {
  id: string;
  bindingId: string;
  route: GatewayRoute;
  input: GatewayInbound;
  sequence: number;
  receivedAt: number;
  relay?: GatewayWhatsAppReceipt & { confirmed: boolean };
  dismissed?: { at: number; revision: string };
  deliveryFinished?: { at: number; revision: string };
  workKept?: { at: number; revision: string; throughSequence: number; serial: number };
  deliveryReviews?: (
    | {
        at: number;
        revision: string;
        action: 'confirmed';
        target: GatewayDeliveryTarget;
        remoteId: string;
        previousRemoteId?: string;
      }
    | { at: number; revision: string; action: 'finish-local' }
  )[];
  status: 'queued' | 'waiting-files' | 'running' | 'done' | 'needs-review';
  operationId?: string;
  reason?: string;
  fileBatch?: string;
  files?: GatewayIncomingFile[];
  dispatch?: GatewayDispatch;
  reply?: { parts: GatewayReplyPart[]; createdAt: number; reason?: string };
  notices?: Partial<Record<'working' | 'approval', GatewayReplyPart>>;
  outgoing?: GatewayOutgoingFile[];
  reconciliation?: GatewayReconciliation;
  album?: { leaderId: string; memberIds?: string[] };
  albumBlocked?: true;
}

export interface GatewayRequestReview {
  revision: string;
  canDismiss: boolean;
  reason: string;
}

export interface GatewayWorkReview {
  revision: string;
  reason: string;
  canKeep: boolean;
  needsPrepare: boolean;
  keptAt?: number;
  heldRequests: number;
  source: {
    platform: GatewayPlatform;
    actor: string;
    conversationId: string;
    threadId: string;
    messageId: string;
    projectId: string;
    target: GatewayTarget;
  };
  operationId?: string;
  native?: {
    state: GatewayDispatch['state'];
    conversation: GatewayLocalConversation;
    runId?: string;
    messageId?: string;
    briefId?: string;
  };
}

export type GatewayDeliveryTarget =
  { kind: 'text' | 'file'; index: number } | { kind: 'notice'; notice: 'working' | 'approval' };

export interface GatewayDeliveryReview {
  revision: string;
  reason: string;
  canFinish: boolean;
  needsPrepare: boolean;
  closedAt?: number;
  source: {
    platform: GatewayPlatform;
    actor: string;
    conversationId: string;
    threadId: string;
    messageId: string;
    projectId: string;
    target: GatewayTarget;
  };
  items: {
    target: GatewayDeliveryTarget;
    label: string;
    text?: string;
    status: GatewayOutgoingFile['status'];
    remoteId?: string;
    canConfirm: boolean;
    confirmedAt?: number;
  }[];
}

export interface GatewayRetiredFinishReview {
  revision: string;
  kind: 'delivery' | 'work' | 'unavailable';
  reason: string;
  canFinish: boolean;
  needsPrepare: boolean;
  closedAt?: number;
  source: GatewayDeliveryReview['source'];
  operationId?: string;
  native?: GatewayWorkReview['native'];
  heldRequests: number;
  items: { label: string; text?: string; status: GatewayOutgoingFile['status']; remoteId?: string }[];
}

export interface GatewayTelegramSetupState {
  version: 1;
  check?: {
    at: number;
    configRevision: string;
    revision: string;
    fingerprint: string;
    webhook: boolean;
    host?: string;
    pendingUpdates: number;
  };
  switches: { at: number; revision: string; state: 'started' | 'confirmed' | 'uncertain'; checkedAt?: number }[];
}

export interface GatewayTelegramSetup {
  reason: string;
  revision: string | null;
  check: { at: number; webhook: boolean; host?: string; pendingUpdates: number } | null;
  attempt: { at: number; state: 'started' | 'confirmed' | 'uncertain'; checkedAt?: number } | null;
  switches: number;
}

/** Local receipt only; raw webhook bodies and relay keys never enter the application inbox. */
export interface GatewayWhatsAppReceipt {
  epoch: string;
  sequence: number;
  id: string;
}

export interface GatewayWhatsAppIntakeState {
  epoch: string;
  cursor: number;
  startedAt?: number;
  senderReviews?: { at: number; throughSequence: number; phone: string; identityKey: string; revision: string }[];
  receipt?: GatewayWhatsAppReceipt & {
    confirmed: boolean;
    accepted: number;
    ignored: number;
    unmatchedSenders: number;
  };
  identities?: GatewayWhatsAppIdentities;
  connection?: GatewayWhatsAppRelayConnection;
  recovery?: { at: number; reason: 'gap' | 'cursor' | 'epoch' | 'installation' | 'envelope' };
  gapReview?: { at: number; from: number; through: number; remoteCursor: number };
  reviewedGaps?: {
    at: number;
    gapAt: number;
    from: number;
    through: number;
    revision: string;
    receipt?: NonNullable<GatewayWhatsAppIntakeState['receipt']>;
  }[];
  restorations?: {
    at: number;
    heldAt: number;
    reason: 'cursor' | 'epoch' | 'installation' | 'envelope';
    revision: string;
    remoteCursor: number;
  }[];
}

export interface GatewayWhatsAppRecovery {
  reason: NonNullable<GatewayWhatsAppIntakeState['recovery']>['reason'] | null;
  gap: { at: number; revision: string } | null;
  restoration?: { at: number; revision: string };
}

/** Private paired identity. Pull/lease tokens are stored separately or kept in memory. */
export interface GatewayWhatsAppRelayConnection {
  origin: string;
  installationId: string;
  businessAccountId: string;
  phoneNumberId: string;
  epoch: string;
}

/** Private setup receipt, stored with gateway secrets so the returned pull key saves atomically. */
export type GatewayWhatsAppPairing =
  | {
      phase: 'requesting';
      attemptId: string;
      origin: string;
      businessAccountId: string;
      phoneNumberId: string;
      replacement?: { epoch: string; revision: string };
    }
  | {
      phase: 'received';
      attemptId: string;
      connection: GatewayWhatsAppRelayConnection;
      cursor: number;
      gap: boolean;
      replacement?: { epoch: string; revision: string };
    };

export interface GatewayWhatsAppSetup {
  paired: boolean;
  pending: null | { phase: GatewayWhatsAppPairing['phase']; revision: string; replacement?: true };
  recoveryRequired: boolean;
}

export interface GatewayWhatsAppReplacement {
  revision: string | null;
  retired: number;
}

export interface GatewayWhatsAppSenders {
  reason: string;
  retired: number;
  waiting: number;
  unallowed: number;
  senders: {
    phone: string;
    status: 'needs-proof' | 'verified' | 'needs-review' | 'reviewed';
    changedAt?: number;
    revision: string | null;
    requests: number;
    reason: string;
  }[];
}

export interface GatewayWhatsAppCheck {
  checkedAt: number;
  account: 'verified';
  relay: 'ready' | 'acknowledgement-pending' | 'needs-review';
}

/** Scoped to one instance, business account and relay epoch; retired IDs are never reused. */
export interface GatewayWhatsAppIdentities {
  businessAccountId: string;
  users: { id: string; phone: string | null; at: number; retired: boolean; parentId?: string }[];
  phoneChanges: { phone: string; at: number }[];
}

export interface GatewayRunInput {
  text: string;
  attachments: string[];
}

export interface GatewayReconciliation {
  at: number;
  state: 'tracking' | 'completed' | 'needs-review';
}

export interface GatewayOutgoingFile {
  path: string;
  name: string;
  size: number;
  sha256: string;
  source?: { runId: string; agentId: string; chatId: string; workspace: string };
  status: GatewayReplyPart['status'] | 'skipped';
  attempts: { day: string; bytes: number }[];
  remoteId?: string;
  retryAt?: number;
  reason?: string;
}

export interface GatewayDispatch {
  conversation: GatewayLocalConversation;
  state: 'starting' | 'running' | 'completed' | 'needs-review';
  startedAt: number;
  runId?: string;
  messageId?: string;
  briefId?: string;
  briefRevision?: number;
  brain?: { answer: string; delegate: Pick<BrainDelegate, 'kind' | 'id' | 'name' | 'message' | 'sent'> | null };
  answer?: string;
}

export interface GatewayReplyPart {
  text: string;
  status: 'pending' | 'sending' | 'sent' | 'uncertain' | 'failed';
  attempts: number;
  remoteId?: string;
  retryAt?: number;
}

/** Exact text and recipient reviewed for an approved Outbox send, separate from native replies. */
export interface GatewayOutboxApproval {
  instanceId: string;
  projectId: string;
  postId: string;
  eventId: string;
  parts: string[];
  revision: string;
}

export interface GatewayOutboxPreview {
  approval: GatewayOutboxApproval;
  recipient: {
    platform: 'telegram' | 'discord';
    instanceName: string;
    accountId: string;
    conversationId: string;
    threadId: string;
    sourceMessageId: string;
    sender: string;
  };
}

export interface GatewayOutboxDestination {
  instanceId: string;
  eventId: string;
  recipient: GatewayOutboxPreview['recipient'];
}

export interface GatewayOutboxProgress {
  state: 'queued' | 'sending' | 'sent' | 'failed' | 'uncertain' | 'held' | 'closed' | 'unavailable';
  recipient?: GatewayOutboxPreview['recipient'];
  parts: { status: GatewayReplyPart['status']; attempts: number; remoteId?: string; retryAt?: number }[];
  approvedAt?: number;
  closedAt?: number;
  reviewRevision?: string;
  reviewAvailable?: true;
  paused: boolean;
}

export type GatewayOutboxReviewRecord =
  | { action: 'confirmed'; at: number; revision: string; index: number; attempt: number; remoteId: string }
  | {
      action: 'retry';
      at: number;
      revision: string;
      index: number;
      attempt: number;
      from: 'pending' | 'failed' | 'uncertain';
    };

export interface GatewayOutboxDeliveryReview {
  revision: string;
  recipient: GatewayOutboxPreview['recipient'];
  paused: boolean;
  removed?: true;
  reason: string;
  needsPrepare: boolean;
  canRetry: boolean;
  retryReason: string;
  nextIndex?: number;
  canFinish: boolean;
  closedAt?: number;
  reviewHeld: boolean;
  parts: {
    text: string;
    status: GatewayReplyPart['status'];
    attempts: number;
    remoteId?: string;
    canConfirm: boolean;
    confirmedAt?: number;
  }[];
}

export interface GatewayOutboxPostPreview extends GatewayOutboxPreview {
  draftRevision: string;
}

/** Private receipt. Fingerprints bind approval to current access, credentials and saved input. */
export interface GatewayOutboxDelivery extends GatewayOutboxApproval {
  recipient: GatewayOutboxPreview['recipient'];
  bindingId: string;
  configHash: string;
  sourceHash: string;
  approvedAt: number;
  receipts: GatewayReplyPart[];
  held?: 'destination-changed';
  reviewHeld?: true;
  reviews?: GatewayOutboxReviewRecord[];
  closed?: { at: number; revision: string };
}

export interface GatewayOutboxJournal {
  version: 1;
  deliveries: GatewayOutboxDelivery[];
}

export type GatewayDeliveryFailureReason = 'whatsapp-window' | 'whatsapp-file-type';
export type GatewayDeliveryOutcome =
  | { remoteId: string }
  | { status: 'pending' | 'failed' | 'uncertain'; retryAt?: number; reason?: GatewayDeliveryFailureReason };

export interface GatewayIncomingFile {
  index: number;
  status: 'pending' | 'transferring' | 'saved' | 'failed';
  attempts: { id: string; day: string; bytes: number }[];
  file?: UploadedFile;
  sha256?: string;
  reason?: string;
}

/** Private ownership of upload scratch files, recorded before streaming any bytes. */
export interface GatewayUploadReservation {
  version: 1;
  instanceId: string;
  projectId: string;
  eventId: string;
  batch: string;
  root: string;
  createdAt: number;
  target: { name: string; dev: number; ino: number; birthtimeMs: number };
  temporary: { name: string; dev: number; ino: number; birthtimeMs: number };
}

/** One atomic receipt includes its binding and route; transport acknowledgement follows this write. */
export interface GatewayInboxJournal {
  version: 1;
  nextSequence: number;
  bindings: GatewayConversationBinding[];
  events: GatewayInboxEvent[];
  retired?: string[];
  retiredQuota?: { day: string; incomingBytes: number; outgoingBytes: number }[];
  retiredAlbums?: string[];
  whatsappRelay?: GatewayWhatsAppIntakeState;
  whatsappRetired?: { at: number; attemptId: string; revision: string; state: GatewayWhatsAppIntakeState }[];
}

export interface GatewayHealth {
  instanceId: string;
  status: 'paused' | 'connecting' | 'connected' | 'needs-setup' | 'retrying';
  reason: string;
  attempts: number;
  updatedAt: number;
  retryAt?: number;
  recoveryRequired?: boolean;
}

/** Navigation metadata only: no credentials, sender rules or message contents. */
export interface GatewayStatus {
  id: string;
  name: string;
  platform: GatewayPlatform;
  projectId: string;
  projectName: string;
  enabled: boolean;
  status: GatewayHealth['status'];
  reviewCount: number | null;
}

/** Stable private runtime identities; the configured agent/team stays the source of its settings. */
export interface PrivateConversation {
  id: string;
  projectId: string;
  conversationId: string;
  target: { kind: 'agent' | 'team'; id: string };
  createdAt: number;
}

export type GatewayLocalConversation = { conversationId: string; projectId: string; sender: string } & (
  { kind: 'brain' } | { kind: 'agent'; agentId: string; chatId: string } | { kind: 'team'; teamId: string }
);
export type ClaudeAuth = 'login' | 'anthropic' | 'openrouter';

/** An API model's advertised limits. Missing capabilities mean the provider did not say. */
/** One entry of GET /api/models (engine=eve, codex, pi…): an API model's details, or less for an engine's own. */
export interface ModelListing extends Partial<Omit<ApiModelInfo, 'id'>> {
  id: string;
  /** Codex: what the model is for */
  description?: string;
}

export interface ApiModelInfo {
  id: string;
  name: string;
  context: number | null;
  tools?: boolean;
  vision?: boolean;
  multipleImages?: boolean;
  reasoningEfforts?: Effort[];
  offline?: boolean;
  /** USD per million tokens, already normalized across providers. */
  price: { in: number; out: number; cached?: number } | null;
}

/** Reported debits stay separate from the USD-equivalent amount used for a run's budget. */
export interface RunBilling {
  source: 'reported' | 'estimated' | 'unavailable';
  chargedUsd?: number;
  chargedDiem?: number;
}

// ---------- agents ----------
/** An agent as its page shows it: with its knowledge files, its workspace folder and the names of its tools. */
export interface AgentDetail extends Agent {
  knowledgeFiles: { label: string; size: number; own: boolean }[];
  workspacePath: string;
  tools: string[];
}
/** One of an agent's harness's own / commands (a Claude Code agent's), for the / menu. */
export interface HarnessCommand {
  name: string;
  about: string;
}
export interface AgentSource {
  type: 'custom' | 'library' | 'hermes' | 'openclaw' | 'claude' | 'brain' | 'preset' | string;
  slug?: string;
  /** a library hire's group (older hires: their old library's division) */
  division?: string;
  preset?: string;
  profile?: string;
}

export interface Agent {
  id: string;
  name: string;
  emoji: string;
  color: string;
  specialty: string;
  description: string;
  systemPrompt: string;
  engine: EngineId;
  model: string;
  provider: ProviderId | string;
  claudeAuth: ClaudeAuth | string;
  hermesProfile: string;
  /** OpenClaw engine: which of your OpenClaw agents answers ('' = its default agent). */
  openclawAgent?: string;
  autonomy: Autonomy;
  toolGroups: string[];
  mcpServers: string[];
  knowledge: { folders: string[] };
  workspace: string;
  temperature: number | '';
  /** How hard the model thinks (see shared/effort.ts). '' or missing = the model's default. */
  effort?: Effort | '';
  alwaysAllow: string[];
  skills: string[];
  /** Rich answers: in your own chats it answers in OpenUI Lang, shown as live components (cards, tables, charts, forms). */
  richAnswers?: boolean;
  source: AgentSource;
  pinned: boolean;
  lastModel?: string;
  lastModelAt?: number;
  createdAt?: number;
  updatedAt?: number;
  /** Set only while an agent works for a team: that team's skills. Never saved. */
  _teamSkills?: string[];
  /** Set only for a run that may not go beyond this autonomy (a webhook's "Agents ask before risky steps"). Never saved. */
  _autonomyCap?: Autonomy;
}

// ---------- teams (stored in the "workflows" collection) ----------
export interface TeamAccess {
  toolGroups: string[];
  mcpServers: string[];
}

export interface Schedule {
  type: 'none' | 'daily' | 'interval' | string;
  /** daily: one or more 'HH:MM' times */
  times?: string[];
  /** interval: every N minutes */
  minutes?: number;
  /** daily: which weekdays (0 = Sunday); empty = every day */
  days?: number[];
  input?: string;
}

/** Old teams were step lists; teams now are group chats with members. Steps mirror the members. */
export interface TeamStep {
  id?: string;
  type: 'agent' | 'tool' | 'approval' | string;
  agentId?: string;
  prompt?: string;
  label?: string;
  tool?: string;
  [k: string]: unknown;
}

export interface Team {
  id: string;
  name: string;
  description: string;
  color?: string;
  /** The symbol in the middle of the team's pod on the map: an emoji ('' or unset = the default 💬). */
  mark?: string;
  /** A picture or 3D model shown there instead of the emoji (a file the server keeps; set by the server, not by saving the team). */
  markFile?: { kind: 'image' | 'model'; ext: string; at: number } | null;
  members: string[];
  lead: string | null;
  access?: TeamAccess;
  skills?: string[];
  /** Reference files the user gave the team (paths in the project's uploads/ folder). */
  files?: string[];
  steps: TeamStep[];
  schedule?: Schedule;
  enabled?: boolean;
  /** Where it sits on the Station map, and its spin. Null = next to the Brain. */
  pos?: { x: number; z: number } | null;
  rot?: number | null;
  angle?: number | null;
  createdBy?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface TeamState {
  working: string[];
  queued: string[];
  /** your /queue messages, posted one by one once nobody is working */
  held?: QueuedMessage[];
  /** your /loop, while it goes */
  loop?: LoopInfo | null;
  /** /resume would pick something up (the team was stopped or paused) */
  resumable?: boolean;
}

/** A team's chat as its page shows it: the thread, who works now, each agent's own session for the team
 *  (agentId → chatId), your /goal while the Brain follows it, and the other teams it can ask (#Team Name). */
export type TeamChat = TeamState & {
  team: Team;
  messages: TeamMessage[];
  sessions: Record<string, string>;
  goal: BrainBrief | null;
  others: TeamRef[];
};

/** A /loop going in a chat: the message sent again every so often (every, in ms) or after each answer. */
export interface LoopInfo {
  text: string;
  every: number | null;
  times: number;
  /** how many were sent so far */
  done: number;
  /** when the next one is due (timed loops), if known */
  next: number | null;
}

/** A message typed with /queue: it waits until the agent or team is done, then goes as usual. */
export interface QueuedMessage {
  id: string;
  text: string;
  attachments?: string[];
  /** (team chats) the message it answers */
  replyTo?: string | null;
  /** who it is from when not you (e.g. the Brain following up on a goal) */
  from?: string;
  /** sent into this run's turn, which hasn't read it yet: it leaves the queue once read, else goes next */
  reading?: string;
  /** sent into a turn just before a restart, and not known to have reached the agent: it waits for you */
  unsent?: boolean;
  ts: number;
}

/** Private run ownership and input receipts; never copied with a project. */
export interface RunAccess {
  toolGroups?: string[];
  mcpServers?: string[];
  skills?: string[];
  /** The run may not go beyond this autonomy, whatever the agent's own setting (a webhook's "ask first"). */
  autonomy?: Autonomy;
}

export interface ExecutionRun {
  id: string;
  projectId: string;
  agentId: string;
  chatId: string;
  engine: EngineId;
  parentRunId: string | null;
  ownerChatId: string;
  ownerAgentId: string;
  depth: number;
  text: string;
  from: string | null;
  attachments: string[];
  context?: TeamContextMessage[];
  workAccess?: RunAccess;
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'stopped' | 'interrupted';
  stopRequested?: boolean;
  steered?: boolean;
  endedAt?: number;
  answer?: string;
  error?: string;
  settled?: boolean;
  completionClaimed?: boolean;
  clearMemoryOnEnd?: boolean;
}

export interface ExecutionQueue {
  projectId: string;
  agentId: string;
  chatId: string;
  items: QueuedMessage[];
  priority: string[];
  paused: boolean;
}

export interface SavedHandoff {
  id: string;
  from: string;
  projectId: string;
  to: string;
  toName: string;
  chatId: string;
  runId: string;
  task: string;
  /** The asker's private conversation (a gateway's, a board task's): only runs in it may collect the answer. */
  conversationId?: string;
  startedAt: number;
  endedAt?: number;
  answer?: string;
  error?: string;
}

export interface ExecutionJournal {
  runs: ExecutionRun[];
  queues: ExecutionQueue[];
  handoffs: SavedHandoff[];
}

export interface SavedTeamAssignment {
  agentId: string;
  msgIds: string[];
  returning: boolean;
  skills: string[];
  steered?: boolean;
  delivery?: { runId: string; chatId: string; from: number; readUpto: number; files: string[] };
}

/** An input saved before posting or waiting for a routing decision. */
export interface SavedTeamInput {
  id: string;
  from: string;
  sender?: string;
  text: string;
  replyTo: string | null;
  attachments: string[];
  skills: string[];
  to: string[];
  track: boolean;
  relay?: TeamRelay;
}

/** Private team coordination; project copies get the transcript without live work ownership. */
export interface SavedTeamWork {
  projectId: string;
  teamId: string;
  queue: SavedTeamAssignment[];
  current: SavedTeamAssignment[];
  interrupted: SavedTeamAssignment[];
  held: QueuedMessage[];
  pending: SavedTeamInput[];
  assigned: string[];
  brain: TeamMessage[];
  episode: { turns: number; chatter?: number; brain?: number; relays?: number };
  stopped: boolean;
  epoch: number;
}

export interface SavedTeamRelay {
  id: string;
  from: string;
  to: string;
  by: string;
  askId: string;
  postedId: string;
  pid: string;
  depth: number;
  returning: boolean;
  skills: string[];
  deliveries: { id: string; messageId: string }[];
}

export interface TeamRelayJournal {
  active: SavedTeamRelay[];
  closed: string[];
}

/** One step of a workflow run (old-style step workflows). */
export interface WorkflowRunStep {
  id?: string;
  label: string;
  type: string;
  status: 'waiting' | 'running' | 'needs-you' | 'done' | 'failed' | 'skipped' | string;
  output: unknown;
  agentId?: string | null;
  agentName?: string;
  images?: string[];
  startedAt?: number;
  finishedAt?: number;
  [k: string]: unknown;
}

/** A workflow run, stored in the "runs" collection. */
export interface WorkflowRun {
  id: string;
  createdAt?: number;
  updatedAt?: number;
  workflowId: string;
  workflowName: string;
  input: string;
  trigger: string;
  status: 'running' | 'done' | 'failed' | 'stopped' | string;
  steps: WorkflowRunStep[];
  output?: unknown;
  error?: string;
  finishedAt?: number;
  [k: string]: unknown;
}

/** A run going now, as the Station lights up its branch (GET /api/workflow-active). */
export interface RunSummary {
  id: string;
  workflowId: string;
  status: WorkflowRun['status'];
  steps: { status: string; label: string; agentId: string | null }[];
  error: string | null;
}

/** A starter team (GET /api/workflow-templates): the agents it needs, by name. */
export interface WorkflowTemplateInfo {
  name: string;
  description: string;
  needs: string[];
}

/** A team as GET /api/workflows returns it: with who is working and its latest message. */
export interface TeamListing extends Team {
  state?: TeamState;
  last?: TeamMessage | null;
}

export interface TeamMessage {
  id: string;
  ts: number;
  from: string; // 'user' | 'system' | 'brain' | agent id | 'team:<id>' (another team)
  sender?: string;
  text: string;
  /** From another team (#Team Name): who there wrote it, and, for that team's answer to a question
   *  asked from here, the message that asked. Names are kept so it reads right after renames. */
  relay?: TeamRelay;
  mentions: string[];
  replyTo?: string | null;
  handedTo?: string[];
  /** An agent's reply: where its turn is in the agent's own session for this team (its steps and tool
   *  calls are items from..to of that chat), so the team chat can show the work behind it. */
  turn?: { chatId: string; from: number; to: number };
  /** An agent's turn that was stopped before it finished (steer: to take your new message). Its work so far is in turn. */
  stopped?: 'stop' | 'steer';
  /** Files and folders attached to the message (paths in the project's uploads/ folder). */
  attachments?: string[];
  [k: string]: unknown;
}

export interface TeamRelay {
  teamId: string;
  teamName: string;
  /** who wrote it there: an agent id, 'user' or 'brain' */
  by: string;
  byName: string;
  /** set on an answer: the message here that asked */
  answers?: string;
}

/** Another team, as a team's chat lists them (for #Team Name). */
export interface TeamRef {
  id: string;
  name: string;
  color?: string;
  mark?: string;
  description: string;
}

// ---------- routines ----------
export type RoutineMentionKind = 'agent' | 'team' | 'skill';

/** Something a routine's text names with @Name. id is a skill's slug for skills. */
export interface RoutineMention {
  kind: RoutineMentionKind;
  id: string;
  name: string;
  /** Set on the way out when the agent, team or skill no longer exists. Never saved. */
  missing?: boolean;
}

/** Saved instructions you run by hand or on a schedule. The @mentioned agents and teams do them,
 *  with the @mentioned skills. */
export interface Routine {
  id: string;
  name: string;
  description?: string;
  text: string;
  mentions: RoutineMention[];
  schedule?: Schedule;
  /** On: it can run by hand or on its schedule. */
  enabled: boolean;
  lastScheduledAt?: number;
  createdAt?: number;
  updatedAt?: number;
}

export interface RoutineRunTarget {
  kind: 'agent' | 'team';
  id: string;
  name: string;
  /** sent: posted in the team chat, where the team carries on */
  status: 'running' | 'done' | 'sent' | 'failed' | 'stopped';
  chatId?: string | null;
  output?: string;
}

export interface RoutineRun {
  id: string;
  routineId: string;
  routineName: string;
  trigger: 'manual' | 'schedule' | 'webhook' | string;
  /** A webhook run: which webhook and delivery started it. */
  source?: { webhookId: string; deliveryId: string };
  status: 'running' | 'done' | 'failed' | 'stopped';
  skills: string[];
  targets: RoutineRunTarget[];
  error?: string | null;
  createdAt?: number;
  updatedAt?: number;
  finishedAt?: number;
}

/** A routine as GET /api/routines returns it: with its latest run. */
export interface RoutineListing extends Routine {
  lastRun?: RoutineRun | null;
}

// ---------- projects ----------
export interface Project {
  id: string;
  name: string;
  description?: string;
  brainPath: string;
  repo: string;
  skills?: string[];
  createdAt: number;
  openedAt?: number;
  /** When its logo (.dashboard/logo.*) last changed; null = no logo. Added by the server when it sends projects. */
  logoAt?: number | null;
  /** The 3D model that replaces the logo inside the Brain's globe (.dashboard/brain-model.*): when it last changed and its file type; null = none. */
  modelAt?: number | null;
  modelExt?: string | null;
  /** The picture behind the Station's map (.dashboard/background.*): when it last changed; null = none. Added by the server. */
  backgroundAt?: number | null;
  /** How strong that picture is, 0-100; missing: 50 in the classic look, 100 in the voxel look (shared/look.ts). */
  backgroundOpacity?: number;
  /** How strong the classic map's floor dots are, 0-100; missing: 100. */
  mapDotsOpacity?: number;
  /** Which voxel world it uses (missing: none of its own yet, see ProjectWorldLink). */
  world?: ProjectWorldLink;
  /** When its scene (.dashboard/scene/, the Station's scene look) last changed: its newest version; null = none.
   *  Added by the server. */
  sceneAt?: number | null;
  /** What the bottom of the sidebar last showed in this project; missing: Settings > Appearance's choice. */
  sidebar?: SidebarPanel;
}
/** A project as the server sends it: when its logo, 3D model and background last changed (null: it has none). */
export type ProjectWithMedia = Project & {
  logoAt: number | null;
  modelAt: number | null;
  modelExt: string | null;
  backgroundAt: number | null;
  sceneAt: number | null;
};
/** What a project folder saved by the dashboard holds (its .dashboard/project.json), at a glance. */
export interface ProjectPeek {
  name: string;
  description: string;
  agents: number;
  teams: number;
  savedAt: number;
}
/** A project on the start screen. */
export type ProjectOverviewItem = Project & {
  agents: number;
  teams: number;
  hasProjectMd: boolean;
  saved: ProjectPeek | null;
};
/** A folder in the projects folder that isn't a project yet. */
export interface FoundFolder {
  name: string;
  folder: string;
  /** PROJECT.md or BRAIN.md, when it has one */
  brief: string | undefined;
  saved: ProjectPeek | null;
}
/** The start screen: every project, and project folders on this computer that aren't on the list yet. */
export interface ProjectsOverview {
  active: string;
  root: string;
  projects: ProjectOverviewItem[];
  found: FoundFolder[];
}
/** The last save of the open project into its folder (<project>/.dashboard). */
export interface SaveStatus {
  at: number;
  error?: string;
  agents?: number;
  teams?: number;
}
/** The project's own settings as its folder saved them. */
export interface SavedProjectSettings {
  name?: string;
  description?: string;
  repo?: string;
  skills?: string[];
  brainPath?: string;
  backgroundOpacity?: number;
  mapDotsOpacity?: number;
}
/** What a project folder saved by the dashboard brought back when it was added. */
export interface RestoreResult {
  agents: number;
  teams: number;
  chats?: number;
  /** kept versions of agents and teams (deleted ones included) */
  versions?: number;
  /** skills added to the library from the folder, and ones the library had already (by name) */
  skills?: { added: string[]; kept: string[] };
  project: SavedProjectSettings;
}

// ---------- backups ----------
/** What the second line of a backup file says: shown before restoring. */
export interface BackupSummary {
  app: string;
  format: number;
  createdAt: number;
  name: string;
  description: string;
  agents: number;
  teams: number;
  routines: number;
  chats: number;
  skills: number;
  presets: number;
  /** prefabs in the prefab library, shared by every project (older backups: missing) */
  libraryPrefabs?: number;
  knowledgeFiles: number;
  /** MEMORY.md files of agents and the Brain (older backups: missing) */
  memories?: number;
  /** Kept versions of agents, teams and skills (older backups: missing) */
  versions?: number;
  /** The first few agents, to recognise the backup by */
  agentList: { name: string; emoji: string }[];
  /** Files left out because their kind's size limit was reached */
  omitted: number;
}
/** A backup just made: its file in the backups folder. */
export interface BackupResult {
  file: string;
  name: string;
  size: number;
  summary: BackupSummary;
}

/** What a backup (or a copy of a project) brought back. */
export interface BackupRestoreResult {
  agents: number;
  teams: number;
  routines: number;
  chats: number;
  knowledgeFiles: number;
  /** MEMORY.md files brought back */
  memories: number;
  brainFiles: number;
  /** skills added to the library; already there and the same; already there but different, so added under a new id */
  skills: { added: number; same: number; renamed: { from: string; to: string }[] };
  presets: { added: number; same: number };
  /** prefab library entries added; already there */
  libraryPrefabs: { added: number; same: number };
  /** kept versions brought back (agents, teams and skills) */
  versions: number;
  /** routines and teams that ran on a schedule: paused, so a copy doesn't run them twice */
  paused: number;
  logo: boolean;
  background: boolean;
  /** the Station's scene (.dashboard/scene/) and its versions came back (older backups: missing) */
  scene?: boolean;
}

// ---------- chats ----------
export type ChatItem = (
  | {
      type: 'user';
      text: string;
      from?: string | null;
      attachments?: string[];
      ts?: number;
      teamMessageId?: string;
      runId?: string;
    }
  | { type: 'assistant'; text: string; ts?: number }
  /** A message sent while the agent worked that it took into the turn going on (it didn't stop):
   *  part of that turn, so the turn still starts at its user message. */
  | {
      type: 'steer';
      steerId: string;
      text: string;
      from?: string | null;
      attachments?: string[];
      ts?: number;
      runId?: string;
      teamMessageId?: string;
    }
  | {
      type: 'tool';
      id: string;
      name: string;
      args?: unknown;
      result?: string | null;
      status: 'running' | 'done' | 'error';
      isError?: boolean;
      images?: string[];
      ts?: number;
      resultSourceId?: string;
    }
  /** stopped: the run was stopped before it finished (steer: to take a new message), not a failure */
  | { type: 'error'; text: string; ts?: number; runId?: string; stopped?: 'stop' | 'steer' }
  /** reset: "Clear memory" (the agent starts fresh after it) */
  | { type: 'meta'; text: string; ts?: number; reset?: boolean; billing?: RunBilling }
  | CompactionItem
) & { sourceId?: string };

/** Full messages imported from the team's shared transcript before a member answers. */
export interface TeamContextMessage {
  id: string;
  text: string;
  from: string;
  ts: number;
}

export interface ConversationSearch {
  query: string;
  scope?: 'own' | 'team' | 'all';
  teamId?: string;
  offset?: number;
  limit?: number;
}

export interface ConversationHit {
  source: 'own' | 'team';
  conversationId: string;
  title: string;
  messageId: string;
  author: string;
  ts: number;
  excerpt: string;
}

export interface ConversationRead {
  source: 'own' | 'team';
  conversationId: string;
  messageId: string;
  offset?: number;
  limit?: number;
}

export interface ConversationSearchResult {
  hits: ConversationHit[];
  total: number;
  nextOffset: number | null;
}

export interface ConversationReadResult {
  source: 'own' | 'team';
  conversationId: string;
  messageId: string;
  title: string;
  text: string;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
}

/** Session search (Settings › Session search): every saved session in the project, not only the caller's own.
 *  An agent chat's owner is its agent id, a team thread's its team id; the Brain's owner is "brain". */
export type SessionSource = 'agent' | 'team' | 'brain';

export interface SessionSearch {
  query: string;
  source?: SessionSource;
  owner?: string;
  offset?: number;
  limit?: number;
}

export interface SessionHit {
  source: SessionSource;
  owner: string;
  ownerName: string;
  sessionId: string;
  title: string;
  messageId: string;
  author: string;
  ts: number;
  excerpt: string;
}

export interface SessionSearchResult {
  hits: SessionHit[];
  total: number;
  nextOffset: number | null;
}

export interface SessionRead {
  source: SessionSource;
  owner: string;
  sessionId: string;
  messageId: string;
  offset?: number;
  limit?: number;
}

export interface SessionReadResult {
  source: SessionSource;
  owner: string;
  sessionId: string;
  messageId: string;
  title: string;
  text: string;
  totalChars: number;
  offset: number;
  nextOffset: number | null;
}

/** A read-only marker reported by the engine that owns the session. */
export type CompactionMode = 'engine';
export type CompactionTrigger = 'auto' | 'manual' | 'overflow';

export interface CompactionItem {
  type: 'compaction';
  id: string;
  /** Empty: the engine keeps its own active memory. */
  text: string;
  mode: CompactionMode;
  trigger: CompactionTrigger;
  /** Index of the first item kept word for word (the items before it are in text). */
  upto: number;
  /** Rough size of the agent's memory before and after, in tokens. */
  tokensBefore?: number;
  tokensAfter?: number;
  ts?: number;
}

/** How full the agent's memory of a chat is, as the engine last said (or as estimated). */
export interface ChatContext {
  tokens: number;
  /** the model's context window, when the engine says it */
  window?: number;
  /** chat.items.length when this was measured: items after it are not counted yet */
  items: number;
  at: number;
  /** which engine, provider and model measured it ("engine|provider|model"): another one ignores it */
  by?: string;
}

export interface Chat {
  id: string;
  agentId: string;
  title: string;
  items: ChatItem[];
  sessionId: string | null;
  /** The engine that answered here last (and made sessionId): another engine can't resume it, so it
   *  starts a new session from the saved originals. */
  sessionEngine?: EngineId;
  /** Set when this is the agent's session for a team chat. */
  teamId?: string | null;
  /** External binding scope; absent for ordinary dashboard conversations. */
  conversationId?: string;
  /** The next CLI session receives the saved original conversation. */
  reseed?: boolean;
  /** How full the agent's memory is (see ChatContext). Cleared when the session is replaced or you clear memory. */
  context?: ChatContext;
  /** Its last run had Rich answers' instructions (a chat of your own, not a handoff or a team's). */
  rich?: boolean;
  /** When the agent's MEMORY.md had last changed as of its last run here (see engines/index.ts). */
  memoryAt?: number;
  /** A fingerprint of the instructions its session last got (the Brain on Codex, Hermes or OpenClaw, which hear them
   *  only when a session starts: changed ones are sent with the next message). */
  instructions?: string;
  createdAt: number;
  updatedAt: number;
  _deleted?: boolean;
  /** GET adds the private saved queue; it is not part of the chat file or project copies. */
  queued?: QueuedMessage[];
  /** Your /loop here, while it goes (GET adds it). */
  loop?: LoopInfo | null;
  /** Your /goal here, while the Brain follows it (GET adds it). */
  goal?: BrainBrief | null;
}

export interface ChatSummary {
  id: string;
  title: string;
  updatedAt: number;
  createdAt: number;
  count: number;
  teamId?: string | null;
  conversationId?: string;
}

/** A conversation of the Brain or of a team, as their list of chats shows it. open: the one shown now (New chat
 *  files it away with the others, and opening another swaps them). */
export interface ThreadSummary {
  id: string;
  title: string;
  /** how many messages it has */
  count: number;
  createdAt: number;
  updatedAt: number;
  open: boolean;
}

// ---------- runs and live events ----------
export type RunEvent =
  | { kind: 'start'; text: string; from?: string | null; attachments?: string[] }
  | { kind: 'text'; text: string }
  /** a message that joined the turn going on (a steer item in the chat) */
  | { kind: 'steer'; id: string; text: string; from?: string | null; attachments?: string[]; teamMessageId?: string }
  | { kind: 'tool'; id: string; name: string; args?: Record<string, unknown> }
  | { kind: 'tool_result'; id: string; text?: string; isError?: boolean; images?: string[] }
  | { kind: 'status'; text: string }
  | { kind: 'model'; model: string }
  | {
      kind: 'usage';
      inputTokens: number;
      outputTokens: number;
      cacheReadTokens: number;
      cacheWriteTokens: number;
      costUsd?: number;
      summary?: boolean;
    }
  | { kind: 'done'; text: string; cost?: number; seconds?: number; billing?: RunBilling }
  /** the engine compacted its own memory (Claude Code): marked in the chat, never sent on as a run event */
  | { kind: 'compacted'; trigger?: string; tokensBefore?: number }
  | { kind: 'error'; text: string };

export interface ActiveRun {
  id: string;
  agentId: string;
  chatId: string;
  /** the project it runs in (a cloned project's chats have the same ids) */
  projectId?: string;
  startedAt: number;
  agentName: string;
  parentRunId: string | null;
  /** above 0: it works for a team or another agent, which waits on its answer */
  depth?: number;
}

/** Everything the server pushes over the /ws socket. Extra fields depend on the type. */
export interface ServerEvent {
  type: string;
  ts: number;
  [k: string]: unknown;
}

// ---------- approvals, outbox, activity ----------
export interface Approval {
  id: string;
  kind: string;
  title: string;
  detail: string;
  agentId: string | null;
  agentName: string;
  data: Record<string, unknown>;
  editable: unknown;
  createdAt: number;
  /** Why the Brain passed this on to you instead of allowing it (Settings > The Brain approves). */
  brainNote?: string;
  /** the project the request came from (older ones: missing) */
  projectId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  message: string;
  edited?: unknown;
  always?: boolean;
  /** Nobody answered in time (not a no from you). */
  timedOut?: boolean;
}

export interface DurableApprovalRecord {
  id: string;
  operationId: string;
  projectId: string;
  fingerprint: string;
  item: Approval;
  expiresAt: number;
  reviewing: boolean;
  decision?: ApprovalDecision;
}

/** A question an agent asked you with ask_user: a choice to make, something only you know, a place it is stuck.
 *  It waits in the Outbox with its choices as buttons and a box for an answer in your own words. */
export interface AgentQuestion {
  /** Eve's saved call owns this wait instead of an in-memory Promise. */
  operationId?: string;
  /** A completion check that stopped for user action. */
  briefId?: string;
  id: string;
  question: string;
  /** what you need to know to answer (Markdown) */
  detail?: string;
  /** the answers you can click (none: an open question) */
  choices: string[];
  /** waiting: not answered yet. closed: the run that asked was stopped. */
  status: 'waiting' | 'answered' | 'dismissed' | 'closed';
  agentId?: string | null;
  agentName?: string;
  /** the chat it was asked in, and the run (while it waits there for the answer) */
  chatId?: string | null;
  runId?: string | null;
  /** asked in a team chat: a late answer goes there */
  teamId?: string | null;
  teamName?: string;
  /** what you clicked, and what you wrote */
  choice?: string;
  reply?: string;
  answeredAt?: number;
  /** how the answer reached the agent: while it waited, or as a new message in its chat or team chat */
  delivered?: 'live' | 'chat' | 'team' | 'nowhere';
  /** why it couldn't be delivered, or why it closed */
  note?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** Something a team finished that isn't an outgoing post: a written result, a file or a folder. */
export interface Artifact {
  id: string;
  title: string;
  kind: 'text' | 'file' | 'folder';
  /** file / folder: the full path, inside the project's folders */
  path?: string;
  /** text: the result itself (Markdown) */
  text?: string;
  note?: string;
  agentId?: string | null;
  agentName?: string;
  /** The team it was done for, named at the time (a renamed team keeps its old name here). */
  teamId?: string | null;
  teamName?: string;
  createdAt?: number;
  updatedAt?: number;
}

export interface OutboxPost {
  id: string;
  platform: 'x' | 'x_dm' | 'reddit' | 'telegram' | 'discord' | string;
  accountId?: string | null;
  accountLabel?: string;
  parts: string[];
  gateway?: { instanceId: string; eventId: string };
  gatewayApprovedRevision?: string;
  gatewayDraftRevision?: string;
  gatewayProgress?: GatewayOutboxProgress;
  /** Image files (full paths inside the project's folders) that go with the first part. X only. */
  images?: string[];
  /** Alt text (a description for people who can't see it) by image path. X only. */
  imageAlt?: Record<string, string>;
  status: 'pending' | 'posting' | 'posted' | 'failed' | 'rejected' | 'returned' | string;
  agentId?: string | null;
  /** The team the draft was written for (named at the time); where Send back to the team goes. */
  teamId?: string | null;
  teamName?: string;
  /** X: ids of the parts already posted (a thread can be finished later), and what it replies to */
  postIds?: string[];
  replyTo?: string | null;
  postedAt?: number;
  error?: string | null;
  reason?: string;
  agentName?: string;
  note?: string;
  url?: string;
  to?: string;
  /** Reddit: a post or a comment; a post may carry a flair (a template id from the subreddit and/or its text). */
  reddit?: {
    kind: 'post' | 'comment';
    subreddit?: string;
    title?: string;
    link?: string;
    parent?: string;
    flairId?: string;
    flairText?: string;
  };
  createdAt?: number;
  updatedAt?: number;
  [k: string]: unknown;
}

export interface ActivityEntry {
  id: string;
  kind: string;
  text: string;
  ts: number;
  agentId?: string;
  chatId?: string;
  [k: string]: unknown;
}

// ---------- settings ----------
/** A tool you let the Brain use without asking (Always allow in Needs you). */
export interface BrainToolGrant {
  server: string;
  tool: string;
}

export interface BrainSetting {
  provider: 'claude' | 'openrouter' | 'venice' | 'hermes' | 'codex' | 'opencode';
  model: string;
  /** How hard it thinks. '' or missing = the model's default. */
  effort?: Effort | '';
}

/** A model you starred in the model picker. provider: for API models (OpenRouter or a server on this PC). */
export interface FavoriteModel {
  engine: EngineId;
  model: string;
  provider?: string;
}

export interface LookSetting {
  /** Light, dark, or whatever the computer is set to (see ThemeChoice). */
  theme: ThemeChoice;
  scale: number;
  accent: string;
  motion: 'full' | 'reduced';
  /** The font chat messages are in (an id from CHAT_FONTS in shared/look.ts). */
  chatFont: string;
  /** How hard the Station's 3D map works: frame rate and sharpness (see STATION_QUALITY in shared/look.ts). */
  station: StationQuality;
  /** What the bottom of the sidebar shows: what's set up, or how much of your Claude and Codex plans is used. */
  sidebar: SidebarPanel;
  /** The Station's look: the classic map, the voxel world's light (sky, sun and shadows, glow), or the project's
   *  scene (an HTML page agents write, docs/internal/plans/HTML_SCENE_PLAN.md). */
  stationLook: StationLook;
  /** How much the voxel world draws: shadows, glow and the miniature blur cost graphics power. */
  worldQuality: WorldQuality;
}
/** Light or dark pages, or following the computer's own setting (the default). */
export type ThemeChoice = 'system' | 'light' | 'dark';
export type StationLook = 'classic' | 'world' | 'scene';
export type WorldQuality = 'low' | 'medium' | 'high';

export type StationQuality = 'smooth' | 'balanced' | 'saver';
export type SidebarPanel = 'status' | 'limits';

/** How freely the Brain acts: full runs everything, ask sends anything that changes something to Needs you,
 *  read only answers and looks things up. */
export type BrainAccess = 'full' | 'ask' | 'read';

export interface Settings {
  defaults: {
    engine: EngineId;
    claudeModel: string;
    openrouterModel: string;
    veniceModel: string;
    hermesProfile: string;
    autonomy: Autonomy;
  };
  providers: { lmstudio: { baseUrl: string }; ollama: { baseUrl: string }; custom: { baseUrl: string; label: string } };
  comfyui: { url: string; workflowDirs: string[] };
  paths: Record<string, string>;
  allowedFolders: string[];
  x: { clientId: string };
  reddit: { clientId: string; username: string };
  brain: BrainSetting;
  /** The Brain answers agents' and teams' permission requests, and only asks you about the risky or unclear ones. */
  brainApproves: boolean;
  /** Skills the Brain itself follows (slugs). With "self-improvement" it also learns from finished work. */
  brainSkills: string[];
  /** The Brain may install skills from any GitHub link, not only from repos you named in the chat. */
  brainAnyGitHub: boolean;
  /** The Brain checks ordinary assignments after each turn and continues until delivered or blocked. */
  brainFollowsUp: boolean;
  /** What the Brain may do without asking, for all its tools (see BrainAccess). */
  brainAccess: BrainAccess;
  /** Every agent, team and the Brain can search and read all saved sessions in the project. Off by default. */
  sessionSearch: boolean;
  look: LookSetting;
  telegram: { chatId: string };
  maxToolSteps: number;
  costLimitUsdPerRun: number;
  contextWindowTokens: number;
  /** A longer tool result keeps its start and end for the model; the whole text is saved in outputs. 0 = no limit. */
  toolResultChars: number;
  /** Models starred in the model picker: they get their own tab at the front. */
  favoriteModels: FavoriteModel[];
  activeProject?: string;
  /** The voxel world projects without a built world of their own show ('' = the most recently built one). */
  defaultWorld: string;
  /** Receiving webhooks (Settings › Webhooks). Changed through the webhooks routes only. */
  webhooks: WebhookSettings;
}

// ---------- webhooks ----------
/** How a sender proves a webhook is really from it. */
export type WebhookPreset =
  'github' | 'gitlab' | 'stripe' | 'slack' | 'linear' | 'standard' | 'hmac' | 'token' | 'none';

/** A webhook's check, without its secret (that stays in data/webhook-secrets.json). */
export interface WebhookVerify {
  preset: WebhookPreset;
  /** hmac and token: the header with the signature or the token. */
  header?: string;
  /** hmac only */
  algorithm?: 'sha256' | 'sha1';
  encoding?: 'hex' | 'base64';
  /** hmac only: text before the signature, such as "sha256=". */
  prefix?: string;
  /** hmac and token: the headers that name the event and the delivery, if the sender sends them. */
  eventHeader?: string;
  idHeader?: string;
}

/** Another service starts a routine by sending to this webhook's secret address. Kept per project, on this PC only. */
export interface Webhook {
  id: string;
  name: string;
  routineId: string;
  enabled: boolean;
  verify: WebhookVerify;
  /** Only these events start a run (empty: every event). */
  events: string[];
  /** The agents the routine reaches directly work at most at "Ask first" for these runs. */
  askFirst: boolean;
  /** At most this many runs start in a minute, and this many go at once. */
  perMinute: number;
  atOnce: number;
  /** Keep what was sent (for Run again), for 7 days. */
  keepBodies: boolean;
  /** The secret address's last characters, to tell addresses apart. */
  addressHint: string;
  /** Why it was turned off by itself (its routine was deleted). */
  offReason?: string;
  createdAt?: number;
  updatedAt?: number;
}

/** A webhook as the page lists it. */
export interface WebhookListing extends Webhook {
  /** No secret address on this PC (data copied from elsewhere): make a new one. */
  needsAddress: boolean;
  /** A signing secret or token is saved. */
  hasSecret: boolean;
  lastDelivery: WebhookDelivery | null;
}

/** What creating a webhook (or making a new address or secret) answers, the one time the secrets are shown. */
export interface WebhookCreated {
  webhook: WebhookListing;
  /** The full address, with the public address when there is one, else this computer's (null: the address didn't
   *  change, and can't be shown again). */
  address: string | null;
  /** A signing secret Athena made (null when the sender gives you one, or the check needs none). */
  secret: string | null;
}

export type WebhookDeliveryStatus = 'started' | 'duplicate' | 'skipped' | 'refused' | 'limited' | 'failed';

/** One request a webhook received, and what came of it. */
export interface WebhookDelivery {
  id: string;
  webhookId: string;
  receivedAt: number;
  status: WebhookDeliveryStatus;
  /** Why it didn't start a run, in plain words. */
  reason: string | null;
  event: string | null;
  /** The sender's own id for this delivery, used to notice repeats. */
  senderId: string | null;
  bytes: number;
  /** Only harmless headers: never ones that carry a signature or token. */
  headers: Record<string, string>;
  /** What was sent (cut to 64 KB), when the webhook keeps it. */
  body?: string;
  routineRunId: string | null;
  createdAt?: number;
  updatedAt?: number;
}

/** The sender ids a webhook started runs for in the last day (its delivery log keeps only the latest few). */
export interface WebhookSeen {
  /** The webhook's id. */
  id: string;
  /** Sender id → when it started a run. */
  ids: Record<string, number>;
  createdAt?: number;
  updatedAt?: number;
}

/** How the webhooks port is shared: not by Athena, a Cloudflare quick tunnel, Tailscale Funnel or Tailscale Serve. */
export type WebhookShare = 'off' | 'cloudflare' | 'tailscale-public' | 'tailscale-tailnet';

export interface WebhookSettings {
  /** Receive webhooks at all. */
  on: boolean;
  /** The webhooks port; null: the dashboard's port + 1. */
  port: number | null;
  /** Where the internet reaches the webhooks port through a tunnel you run yourself ('' when there is none). */
  publicUrl: string;
  /** The tunnel Athena runs (Settings › Webhooks' selector). Started again when Athena starts. */
  share: WebhookShare;
  /** Where cloudflared and tailscale are, when they aren't found by themselves ('' to look for them). */
  toolPaths: { cloudflared: string; tailscale: string };
  /** The last address the tunnel had. */
  tunnelUrl: string;
  /** The Cloudflare address changed since the senders were told: they need each webhook's new address. */
  tunnelChanged: boolean;
}

/** The tunnel Athena runs, as Settings › Webhooks shows it. */
export interface WebhookTunnel {
  share: WebhookShare;
  state: 'off' | 'starting' | 'on' | 'stopped';
  /** Its public address ('' until known). */
  address: string;
  /** Whether Check reached this computer through it (null: not checked yet). */
  reached: boolean | null;
  /** What's going on or what to do, in plain words. */
  message: string | null;
  /** The message is about the dashboard being reachable. */
  danger: boolean;
  /** A link to open (allow Funnel, get the tool) and its words. */
  link: string | null;
  linkLabel: string | null;
  changed: boolean;
  /** Which tools are installed. */
  tools: { cloudflared: boolean; tailscale: boolean };
  /** The paths set in Settings ('' to find them by themselves). */
  toolPaths: { cloudflared: string; tailscale: string };
  /** The tool's last lines of output. */
  output: string[];
}

/** How the webhooks listener is doing. */
export interface WebhookStatus {
  on: boolean;
  listening: boolean;
  port: number;
  /** The port set in Settings (null: the default). */
  portSet: number | null;
  /** The port used when none is set. */
  defaultPort: number;
  publicUrl: string;
  /** Why it isn't listening, in plain words. */
  error: string | null;
  /** The tunnel Athena runs. */
  tunnel: WebhookTunnel;
}

export type SecretKey =
  | 'openrouterKey'
  | 'veniceKey'
  | 'anthropicKey'
  | 'customKey'
  | 'xClientSecret'
  | 'telegramBotToken'
  | 'discordWebhook'
  | 'redditClientSecret';
export type SecretStatus = Record<SecretKey, { set: boolean; hint?: string }>;

/** A saved Venice key can be valid while access is blocked or its credits have run out. */
export interface VeniceAccountInfo {
  accessPermitted: boolean;
  expiresAt: string | null;
  expired: boolean;
  balances: { usd: number | null; diem: number | null; bundled: number | null };
}

// ---------- engines ----------
/** How one tool was used, counted on this computer only (data/tool-stats.json). */
export interface ToolStat {
  name: string;
  calls: number;
  errors: number;
  denied: number;
  /** Results that were longer than the limit and reached the model shortened. */
  clipped: number;
  /** Calls that asked you (or the Brain) first. */
  asked: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  totalChars: number;
  maxChars: number;
  lastAt: number;
}

export interface EngineCapabilities {
  nativeSession: boolean;
  directTools: boolean;
  inlineAttachmentText: boolean;
  durableSession: boolean;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface EveRuntimeConfiguration {
  runId: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  headers: Record<string, string>;
  instructions: string;
  contextWindow: number;
  provider: string;
  effort: Effort | '';
  temperature?: number;
  cacheKey: string;
  maxModelSteps: number;
  costLimitUsd: number;
  costBaseline: number;
  spentUsd?: number;
  capabilities?: Pick<ApiModelInfo, 'tools' | 'vision' | 'multipleImages'>;
  price?: ApiModelInfo['price'];
  tools: { name: string; description: string; inputSchema: Record<string, JsonValue> }[];
}

/** Private runtime records are not part of browser state or project exports. */
export interface EveSessionBinding {
  conversationId?: string;
  id: string;
  projectId: string;
  agentId: string;
  chatId: string;
  teamId: string | null;
  generation: string;
  runtimeVersion: string;
  sessionId: string | null;
  retired: boolean;
  retiring?: boolean;
  runtimeEnded?: boolean;
  createdAt: number;
  imported?: string[];
}

export interface EveModelSelection {
  provider: string;
  baseUrl: string;
  model: string;
  effort: Effort | '';
  temperature?: number;
  contextWindow: number;
  maxModelSteps: number;
  costLimitUsd: number;
  capabilities?: Pick<ApiModelInfo, 'tools' | 'vision' | 'multipleImages'>;
  price?: ApiModelInfo['price'];
}

export type EveMessagePart =
  { type: 'text'; text: string } | { type: 'file'; data: string; mediaType: string; filename: string };
export interface EveAdmissionRecord {
  id: string;
  bindingId: string;
  mode: 'create' | 'send';
  sessionId: string | null;
  message: EveMessagePart[];
  history: { id: string; role: 'user' | 'assistant'; text: string }[];
  historyKeys: string[];
  messageHash: string;
  fingerprint: string;
  status: 'prepared' | 'accepted' | 'cancelled';
  createdAt: number;
  selection: EveModelSelection;
}

export type EveRunStatus = 'queued' | 'running' | 'waiting' | 'completed' | 'failed' | 'stopped' | 'interrupted';

export interface EveRunRecord {
  id: string;
  bindingId: string;
  depth: number;
  parentRunId: string | null;
  deliveryId: string | null;
  turnId: string | null;
  status: EveRunStatus;
  configurationVersions: string[];
  cursor: { line: number; index: number } | null;
  /** Event identities and normalized outputs are saved together before publication. */
  events: { id: string; event: RunEvent }[];
  textParts?: Record<string, string>;
  projected?: number;
  limitReason?: string;
  costBaseline?: number;
  charges?: EveModelCharge[];
  answer?: string;
  error?: string;
  endedAt?: number;
  pendingTerminal?: {
    line: number;
    status: 'completed' | 'failed' | 'stopped' | 'interrupted';
    parts: string[];
    error?: string;
  };
  /** Messages sent into this run's turn while it worked (saved before they are sent). */
  steers?: EveSteer[];
  /** Other deliveries its turn took in (the steers', recorded even before a steer learns its delivery) */
  joinedDeliveries?: string[];
  /** it follows a turn Eve started with a late steer: what came before that turn's message isn't its own */
  adopted?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** A message sent into a running Eve turn. One the turn took is in joinedDeliveries; a delivered one that
 *  missed the turn (it ended first) starts the next turn, which a new run (adoptedBy) follows. */
export interface EveSteer {
  id: string;
  text: string;
  attachments: string[];
  from?: string | null;
  teamMessageId?: string;
  deliveryId: string | null;
  adoptedBy?: string;
  /** it never reached Eve, or missed a team turn: the message went the ordinary way instead */
  dropped?: boolean;
  at: number;
}

/** One acknowledged model response, including charges that preceded a lost native checkpoint. */
export interface EveModelCharge {
  id: string;
  cost?: number;
  billing: RunBilling;
}

export interface EveToolResult {
  text: string;
  isError?: boolean;
  images?: string[];
  denied?: boolean;
  modelImages?: string[];
}

export interface EveToolOperation {
  id: string;
  runId: string;
  bindingId: string;
  sessionId: string;
  callId: string;
  name: string;
  args: Record<string, unknown>;
  origin: string;
  risk: 'none' | 'low' | 'high';
  fingerprint: string;
  status: 'prepared' | 'waiting' | 'running' | 'completed' | 'uncertain' | 'cancelled';
  result?: EveToolResult;
  approvalId?: string;
  approvalChecks?: string[];
  questionId?: string;
  interactionId?: string;
  interactionSettled?: boolean;
  responseDeliveryId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface EngineStatus {
  'claude-code': { installed: boolean; path: string | null; loggedIn: boolean; version: string | null };
  eve: { openrouter: boolean; venice: boolean; custom: boolean };
  hermes: { installed: boolean; path: string | null };
  codex: { installed: boolean; loggedIn: boolean; version: string | null; path?: string | null; how?: string };
  pi: { installed: boolean; path: string | null; version: string | null };
  omp: { installed: boolean; path: string | null; version: string | null };
  openclaw: { installed: boolean; path: string | null; version: string | null };
  /** tooOld: opencode 1.x, which agents can't run on */
  opencode: { installed: boolean; path: string | null; version: string | null; tooOld: boolean };
}

export interface EngineInfo {
  id: EngineId;
  label: string;
  description?: string;
}

export interface ToolGroup {
  id: string;
  label: string;
  description: string;
}

// ---------- accounts ----------
export interface XAccount {
  id: string;
  username: string;
  name: string;
  autopost: boolean;
  connectedAt: number;
  avatar?: string;
}

export interface RedditAccount {
  id: string;
  username: string;
  autopost: boolean;
  connectedAt: number;
  icon?: string;
}

export interface Accounts {
  x: XAccount[];
  xAppConfigured: boolean;
  telegram: { configured: boolean };
  discord: { configured: boolean };
  reddit: RedditAccount[];
  redditAppConfigured: boolean;
}

export interface Terminal {
  id: string;
  title: string;
  agentId: string | null;
  createdAt: number;
  exited: boolean;
  exitCode: number | null;
  command: string;
  /** the project open when it was made (the Overview lists it there) */
  projectId?: string;
}

/** GET /api/state: everything the browser needs to draw. */
export interface AppState {
  gateways: GatewayStatus[];
  agents: Agent[];
  mcpServers: string[];
  /** each MCP server's label, service and "use for" (an older server leaves it out) */
  mcpInfo?: Record<string, McpServerInfo>;
  project: Project;
  projectSaved: SaveStatus | null;
  projects: Project[];
  approvals: Approval[];
  outboxPending: number;
  /** questions from agents waiting for your answer (in the Outbox) */
  questions: AgentQuestion[];
  runs: ActiveRun[];
  /** the projects a Brain turn is going on in (runs leaves the Brain's own turns out); an older server: missing */
  brainThinking?: string[];
  engines: EngineStatus;
  engineList: EngineInfo[];
  toolGroups: ToolGroup[];
  settings: Settings;
  secrets: SecretStatus;
  accounts: Accounts;
  terminals: Terminal[];
  port: number;
  home: string;
  dataDir: string;
  /** the desktop app started this server (files open with their own programs there) */
  desktop?: boolean;
}

// ---------- skills and presets ----------
export interface SkillFile {
  path: string;
  size: number;
}

export interface Skill {
  slug: string;
  name: string;
  description: string;
  body: string;
  source: 'library' | 'claude';
  files: SkillFile[];
  updatedAt: number;
  /** Where it was installed from (GitHub), if it was. */
  origin?: SkillOrigin;
}

/** A skill installed from GitHub: where from (<skill>/.source.json). */
export interface SkillOrigin {
  url: string;
  /** owner/repo */
  repo: string;
  ref: string;
  /** the skill's folder in the repo ('' = the repo itself) */
  path: string;
  installedAt: number;
}

/** POST /api/skills/install: what installing from a GitHub link did. */
export interface SkillInstallResult {
  installed: { slug: string; name: string; updated: boolean; files: number }[];
  /** skills found but not installed, and why */
  skipped: string[];
}

export interface SkillListing extends Omit<Skill, 'body'> {
  preview: string;
  /** a skill of yours with the id of one that comes with the dashboard (which wasn't added): drawn as yours */
  mine?: true;
}

export interface ClaudeSkill {
  slug: string;
  name: string;
  description: string;
  files: number;
  inLibrary: boolean;
}

export interface PresetListing {
  id: string;
  kind: 'agent' | 'team';
  name: string;
  description: string;
  emoji: string | null;
  color: string | null;
  members: { name: string; emoji: string }[] | null;
  lead: string | null;
  skills: string[];
  savedAt: number;
}

/** What a preset keeps of an agent: everything but what belongs to one copy of it. */
export type AgentTemplate = Omit<
  Agent,
  | 'id'
  | 'createdAt'
  | 'updatedAt'
  | 'lastModel'
  | 'lastModelAt'
  | 'pinned'
  | 'workspace'
  | '_teamSkills'
  | '_autonomyCap'
>;
/** What a preset keeps of a team (its members are kept as agents beside it). */
export type TeamTemplate = Partial<Pick<Team, 'name' | 'description' | 'color' | 'access' | 'skills' | 'schedule'>>;
export interface AgentPreset {
  id: string;
  kind: 'agent';
  name: string;
  description: string;
  savedAt: number;
  agent: AgentTemplate;
}
export interface TeamPreset {
  id: string;
  kind: 'team';
  name: string;
  description: string;
  savedAt: number;
  team: TeamTemplate;
  members: AgentTemplate[];
  leadIndex: number;
}
export type Preset = AgentPreset | TeamPreset;

/** A Hermes profile on this PC (`hermes profile list`): hiring one makes a Hermes agent of it. */
export interface HermesProfile {
  name: string;
  model: string;
  gateway: string;
  isDefault: boolean;
}

/** An OpenClaw agent on this PC (`openclaw agents list`): an agent of the dashboard can run as one. */
export interface OpenClawAgent {
  id: string;
  model: string;
  workspace: string;
  isDefault: boolean;
}

/** A Claude Code subagent (~/.claude/agents/<slug>.md), as the Agent library lists it. */
export interface ClaudeSubagentListing {
  slug: string;
  name: string;
  description: string;
  model: string;
}

/** GET /api/library: Athena's agents, this PC's Hermes profiles and Claude Code subagents. */
export interface LibraryIndex {
  agents: LibraryAgentListing[];
  hermes: HermesProfile[];
  claude: ClaudeSubagentListing[];
}

/** One of the Agent library's agents (library/athena-agents), as GET /api/library lists it: not hired yet. */
export interface LibraryAgentListing {
  slug: string;
  name: string;
  description: string;
  emoji: string;
  color: string;
  specialty: string;
  /** its group's id and label (groups.json) */
  group: string;
  groupLabel: string;
  /** the tool groups it starts with */
  tools: string[];
  /** the skills it starts with */
  skills: string[];
  /** '' unless it needs one engine */
  engine: string;
  /** one of the starter team the Home page adds in one click */
  starter: boolean;
}

// ---------- versions (skills, agents, teams) ----------
export type VersionKind = 'skill' | 'agent' | 'team' | 'memory';
/** Who replaced a version: you, the Brain, or an agent (its own MEMORY.md). */
export type VersionAuthor = 'you' | 'brain' | 'agent';
/** One kept version, as GET /api/versions/:kind/:id lists it. */
export interface VersionEntry {
  id: string;
  /** when it was replaced or deleted */
  at: number;
  /** who replaced it */
  by: VersionAuthor;
  deleted?: boolean;
  note?: string;
  /** what the next version (or the current one) changed in it */
  changes: string[];
}
/** GET /api/versions/:kind/:id */
export interface VersionHistory {
  kind: VersionKind;
  id: string;
  name: string;
  /** the current one as text, or null when it's deleted */
  current: string | null;
  versions: VersionEntry[];
}
/** GET /api/versions/:kind/:id/:vid: one version as text. */
export interface VersionDetail extends VersionEntry {
  name: string;
  text: string;
}
/** GET /api/versions/:kind: what was deleted and can come back. */
export interface DeletedItem {
  kind: VersionKind;
  id: string;
  name: string;
  at: number;
  by: VersionAuthor;
}

// ---------- MEMORY.md ----------
/** GET /api/memory/:owner: an agent's MEMORY.md (owner: its id), or the Brain's (owner "brain"). */
export interface MemoryInfo {
  owner: string;
  /** whose it is: the agent's name, or "The Brain" */
  name: string;
  text: string;
  /** when it last changed (0: never written) */
  updatedAt: number;
  /** the most it may hold, in characters */
  max: number;
}

// ---------- the Brain ----------
export type BrainDone = {
  kind:
    | 'team'
    | 'hired'
    | 'file'
    | 'routine'
    | 'skill'
    | 'model'
    | 'mcp'
    | 'stop'
    | 'memory'
    | 'world'
    | 'task'
    | 'board'
    | 'error'
    | 'note';
  text: string;
  teamId?: string;
  agentId?: string;
  routineId?: string;
  skillId?: string;
  taskId?: string;
  file?: string;
  /** whose MEMORY.md it changed (an agent id, or "brain") */ memory?: string;
  /** a task on the Tasks board it added or changed */ boardTask?: { projectId: string; id: string };
};
/** A tool the Brain used while it answered (it reads the project's files). */
export interface BrainStep {
  id: string;
  name: string;
  input: unknown;
  state: 'running' | 'done' | 'error';
  output: string;
}
export interface BrainDelegate {
  kind: 'agent' | 'branch';
  id: string;
  name: string;
  message: string;
  /** The files you attached for the Brain, handed on with the work. */
  attachments?: string[];
  /** Set once the server handed it on: the Brain's message in the team chat, or the agent chat it started. */
  sent?: { messageId?: string; ts?: number; chatId?: string; runId?: string };
}

/** A saved task list within one project. */
export interface TaskScope {
  kind: 'brain' | 'agent' | 'team';
  id?: string;
}
export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';
export interface WorkTask {
  id: string;
  subject: string;
  description: string;
  activeForm: string;
  status: TaskStatus;
  scope: TaskScope;
  /** Empty, brain, agent:<id>, or team:<id>. */
  owner: string;
  blockedBy: string[];
  blocks: string[];
  metadata: Record<string, unknown>;
  briefId?: string;
  createdAt: number;
  updatedAt: number;
}
export type TaskSummary = Omit<WorkTask, 'description' | 'metadata' | 'blocks'>;
export interface TaskPage {
  tasks: TaskSummary[];
  total: number;
  nextOffset: number | null;
}
export interface TaskCreateInput {
  subject: string;
  description: string;
  activeForm?: string;
  metadata?: Record<string, unknown>;
  scope?: TaskScope;
  owner?: string;
}
export interface TaskUpdateInput {
  taskId: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
  activeForm?: string;
  owner?: string;
  metadata?: Record<string, unknown>;
  addBlocks?: string[];
  addBlockedBy?: string[];
  removeBlocks?: string[];
  removeBlockedBy?: string[];
  /** Reject an edit made against an older saved version. */
  expectedUpdatedAt?: number;
}
export type TaskBatchInput<T> = { tasks: T[] };
export type TaskCreateArgs = TaskCreateInput | TaskBatchInput<TaskCreateInput>;
export type TaskUpdateArgs = TaskUpdateInput | TaskBatchInput<TaskUpdateInput>;
export type TaskBatchItem =
  | { index: number; success: true; taskId: string; status: TaskStatus; updatedAt: number }
  | { index: number; success: false; error: string; code: number };
export interface TaskBatchResult {
  results: TaskBatchItem[];
}
export interface TaskQuery {
  scope?: TaskScope;
  view?: string;
  status?: 'open' | TaskStatus | 'all';
  search?: string;
  offset?: number;
  limit?: number;
}

// ---------- the Tasks board ----------
/** The board's columns, in order (any can move to any other). */
export type BoardStatus = 'todo' | 'in_progress' | 'in_review' | 'blocked' | 'done';
export type BoardPriority = 'urgent' | 'high' | 'normal' | 'low';
/**
 * A task on the Tasks board (data/projects/<id>/board.json): work you track for the project, with a
 * description, a status, a priority and someone who has it. Not the step lists agents keep in their chats.
 */
export interface ProjectTask {
  id: string;
  /** #12: counts up in each project */
  number: number;
  title: string;
  description: string;
  status: BoardStatus;
  priority: BoardPriority;
  /** '' (no one), 'you', 'brain', 'agent:<id>' or 'team:<id>' */
  assignee: string;
  /** its place in its column (smaller is higher) */
  rank: number;
  /** why it is Blocked (only while it is) */
  blockedReason?: string;
  /** 'you', 'brain' or 'agent:<id>' */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
  /** when it went to Done */
  doneAt?: number;
  /** what people said about it, oldest first (Markdown) */
  comments?: TaskComment[];
  /** files attached to the task itself */
  files?: TaskFile[];
  /** the agent's or team's work on it: the one going now, or the last one */
  work?: TaskWork;
  /** its tags (ids of the project's BoardTag), in the order they were put on; left out when it has none */
  tags?: string[];
}

/** A tag on a project's Tasks board (kept in its board.json): a name with an emoji if it has one. */
export interface BoardTag {
  id: string;
  /** unique in the project, compared in lower case without a leading emoji (shared/boardtags.ts) */
  name: string;
  /** one emoji */
  emoji?: string;
  /** 'you', 'brain' or 'agent:<id>' */
  createdBy: string;
  createdAt: number;
}
/** A tag with how many of the project's tasks have it. */
export interface BoardTagUse extends BoardTag {
  tasks: number;
}

/** A file on a task or a comment: a copy in the task's own project's uploads folder (path relative to it). */
export interface TaskFile {
  path: string;
  name: string;
  size: number;
  sha256?: string;
  /** 'you' or 'agent:<id>' */
  by: string;
  at: number;
}

/** Where a task's work stands. starting: saved, not started yet. waiting: it needs your OK for a step. */
export type TaskWorkState = 'starting' | 'working' | 'waiting' | 'review' | 'blocked' | 'stopped' | 'needs-review';

/** An agent, a team or the Brain working on a task, in a conversation of its own (board-<taskId>). One at a time. */
export interface TaskWork {
  /** chosen before anything starts: the run's id, the team message's id or the Brain's answer's */
  operationId: string;
  conversationId: string;
  /** who was given it: an agent, a team (its private thread for this task) or the Brain (id 'brain') */
  target: { kind: 'agent' | 'team' | 'brain'; id: string };
  /** the Brain's work: the agent or team it handed the task to (chatId or teamId is theirs) */
  handedTo?: { kind: 'agent' | 'team'; id: string };
  /** the agent's private chat for this task */
  chatId?: string;
  /** the team's private thread for this task */
  teamId?: string;
  runId?: string;
  messageId?: string;
  startedAt: number;
  state: TaskWorkState;
  endedAt?: number;
  /** what to check, for needs-review; the reason, for blocked */
  note?: string;
}
/** A comment on a board task: from you, the Brain or an agent. */
export interface TaskComment {
  id: string;
  /** 'you', 'brain' or 'agent:<id>' */
  by: string;
  /** Markdown */
  text: string;
  at: number;
  editedAt?: number;
  files?: TaskFile[];
}
/** A comment as the task page shows it: with its writer's name. */
export interface BoardComment extends TaskComment {
  byName: string;
  byEmoji?: string;
}
/** A board task as the board shows it: with its project and the names of who has it and who made it. The
 *  board's list carries only how many comments it has; the task's own page gets them. */
export interface BoardTask extends Omit<ProjectTask, 'comments'> {
  commentCount: number;
  /** the task's files and its comments' */
  fileCount: number;
  comments?: BoardComment[];
  projectId: string;
  projectName: string;
  assigneeName: string;
  assigneeEmoji?: string;
  assigneeColor?: string;
  creatorName: string;
  /** who works on it, by name (with work) */
  workerName?: string;
  /** its tags, in order */
  tagList: BoardTag[];
}
/** GET /api/task-board: the cards, every project with how many open tasks it has, and the tags of the projects shown. */
export interface TaskBoardData {
  projects: { id: string; name: string; open: number }[];
  tasks: BoardTask[];
  /** each shown project's tags, by project id */
  tags: Record<string, BoardTagUse[]>;
}
/** One thing on the Overview page's sidebar: an agent, a team, the Brain, or a board task being worked on. */
export interface OverviewSession {
  kind: 'agent' | 'team' | 'brain' | 'task' | 'terminal';
  /** the agent's, team's or task's id ('brain' for the Brain) */
  id: string;
  name: string;
  emoji?: string;
  color?: string;
  /** an agent's engine (its mark) */
  engine?: EngineId;
  /** working: running now. needs-you: an approval, a question or a stopped check waits for you. */
  status: 'working' | 'needs-you' | 'idle';
  /** what needs you, in a few words */
  why?: string;
  /** when it last changed (0: never) */
  updatedAt: number;
  /** an agent's newest chat */
  chatId?: string;
  /** a task's #number */
  number?: number;
  /** a terminal whose program has ended */
  ended?: boolean;
}
/** A project on the Overview page, with its sessions and how many work or need you. */
export interface OverviewProject {
  id: string;
  name: string;
  sessions: OverviewSession[];
  working: number;
  needsYou: number;
  /** open tasks on its board */
  boardOpen: number;
}
/** GET /api/overview: every project at a glance (names and times only, no chat contents). */
export interface OverviewData {
  /** the project open now */
  active: string;
  projects: OverviewProject[];
}
/** One entry of a project folder, as the Overview's Files panel lists it. */
export interface FolderEntry {
  name: string;
  dir: boolean;
  /** bytes (files only) */
  size?: number;
  /** the full path */
  path: string;
  /** the path from the project folder ('/'-separated) */
  rel: string;
}
/** GET /api/projects/:id/folder: one folder of a project, its folders first. */
export interface FolderListing {
  /** the folder's path from the project folder ('' for the project folder itself) */
  rel: string;
  entries: FolderEntry[];
  /** entries left out past the limit */
  more: number;
}
/** POST /api/task-board-draft: the Brain drafts a task's title and description, or a comment. */
export interface BoardDraftInput {
  projectId: string;
  kind: 'task' | 'comment';
  /** the task a comment (or a task's new description) is for */
  taskId?: string;
  title?: string;
  description?: string;
  /** the comment written so far */
  text?: string;
  /** what the user wants it to say */
  instruction?: string;
}
export type BoardDraft = { kind: 'task'; title: string; description: string } | { kind: 'comment'; text: string };
/** Who a project's tasks can go to (the new task window and the task page). */
export interface BoardPeople {
  agents: { id: string; name: string; emoji?: string; color?: string }[];
  teams: { id: string; name: string }[];
}

/** Work the Brain handed to a team or an agent, and how its follow-up went (data/projects/<id>/brain-briefs.json). */
export interface BrainBrief {
  id: string;
  kind: 'team' | 'agent';
  /** the team or agent id */
  targetId: string;
  name: string;
  /** what the Brain asked for */
  text: string;
  ts: number;
  /** a team: the Brain's message in the thread; an agent: the chat it works in */
  messageId?: string;
  chatId?: string;
  followUps: number;
  /** open: working. done: delivered. blocked: needs the user. stuck: no progress. */
  status: 'open' | 'done' | 'blocked' | 'stuck' | 'stopped' | 'replaced' | 'cleared';
  /** Created from an ordinary assignment; no command is needed. */
  automatic?: boolean;
  /** An automatic brief the agent (set_goal), the team's lead or the Brain's check saw as real work:
   *  only then does it show as a goal. Until then it may still turn out to be a simple question. */
  recognized?: boolean;
  /** What done looks like, as the agent or the team's lead put it with set_goal (the user's words stay in goal). */
  doneWhen?: string;
  revision?: number;
  stalled?: number;
  /** Evidence of the last advance, for detecting repeated claims of progress. */
  progress?: string;
  workStamp?: string;
  failures?: number;
  userAction?: string;
  /** Completion condition: the original user request, or an explicit /goal. */
  goal?: string;
  /** chat: assigned directly in this chat; completion reports there. */
  origin?: 'chat';
  /** the Brain's last word on it, for you */
  summary?: string;
  updatedAt?: number;
}

/** One file or folder saved by POST /api/uploads/:batch. top: the file itself, or the dropped folder it is in. */
export interface UploadedFile {
  path: string;
  top: string;
  kind: 'file' | 'folder';
  name: string;
  size: number;
}
/** One line of the Brain chat history (data/projects/<id>/brain-chat.json). */
export interface BrainChatMessage {
  role: 'user' | 'brain';
  /** What was said. For the Brain, its answer alone: what it did is in done and delegate. */
  text: string;
  ts: number;
  attachments?: string[];
  from?: string;
  operationId?: string;
  /** Of a message others' words went into (a board task with agents' comments): the part the user wrote. GitHub
   *  links and MCP server settings the Brain acts on are checked against this, not the whole text. */
  ownWords?: string;
  /** What the Brain did with this answer, so a reopened chat shows it the way it first did. */
  done?: BrainDone[];
  /** Who it handed the work to, and where (a reopened chat follows that work again). */
  delegate?: Pick<BrainDelegate, 'kind' | 'id' | 'name' | 'message' | 'sent'>;
  /** The files it read while it answered (results cut short). */
  steps?: BrainStep[];
  /** A note nobody asked for (what the Brain learned from finished work): its session hears it with the next message. */
  note?: boolean;
}

/** A file or folder at the top of the Brain folder. */
export interface BrainEntry {
  name: string;
  dir: boolean;
  path: string;
}

export interface BrainGit {
  branch: string;
  remote: string;
  url: string;
  last: string;
  changes: number;
}

/** What a project is about: its description, or the first paragraph of PROJECT.md / README.md. */
export interface ProjectSummary {
  text: string;
  from: 'description' | 'PROJECT.md' | 'README.md' | null;
}

/** A look inside the Brain folder (GET /api/brain): top files and folders, size, and Git status. */
export interface BrainInfo {
  project: Project;
  entries: BrainEntry[];
  files: number;
  sizeMB: number;
  git: BrainGit | null;
  summary: ProjectSummary;
}

/** The project at a glance, as the Brain sees it (GET /api/brain/pulse). */
export interface BrainPulse {
  project: string;
  agents: number;
  working: number;
  teams: number;
  teamsWorking: number;
  approvals: number;
  outbox: number;
  questions: number;
  brain: Settings['brain'] | null;
}

export interface BrainAnswer {
  answer: string;
  done: BrainDone[];
  delegate: BrainDelegate | null;
  model: { provider: string; model: string; fallback?: boolean };
  project: string;
}

// ---------- usage meters in the header ----------
export interface UsageMeter {
  label: string;
  percent?: number | null;
  resetsAt?: number | null;
  text?: string | null;
}
/** A Claude plan window: how much is used, and when it starts over. */
export interface UsageWindow {
  percent: number;
  resetsAt: number | null;
}
export interface ClaudeUsage {
  session: UsageWindow | null;
  week: UsageWindow | null;
  at?: number;
}
/** A connector on your Claude account. */
export interface Connector {
  id: string;
  name: string;
  status: 'connected' | 'needs-auth' | 'failed' | 'off';
  detail: string;
}
/** GET /api/headbar: the usage meters (one entry per provider that reports any) and Claude account connectors. */
export interface HeadbarInfo {
  usage: ClaudeUsage | null;
  usages: ProviderUsage[];
  connectors: Connector[];
}
/** What POST /api/settings/test-openrouter passes on from OpenRouter's /key endpoint. */
export interface OpenRouterKeyInfo {
  label?: string;
  limit_remaining?: number | null;
  usage?: number | null;
}
/** One of an X account's recent posts (GET /api/accounts/x/:id/posts). */
export interface XPost {
  id: string;
  text: string;
  createdAt?: string;
  /** like_count, retweet_count, reply_count… as X counts them */
  metrics?: Record<string, number>;
  url: string;
}
/** One built-in tool as GET /api/tools lists it; risk 'varies' when it depends on what the call does. */
export interface ToolListing {
  name: string;
  group: string;
  risk: 'none' | 'low' | 'high' | 'varies';
  description: string;
}
/** How each tool has been used on this computer, since when (GET /api/tool-stats). */
export interface ToolStats {
  since: number;
  tools: ToolStat[];
}

export interface ProviderUsage {
  id: 'claude' | 'openrouter' | 'venice' | 'codex';
  name: string;
  meters: UsageMeter[];
}

/** One usage limit of a plan: how much of it is used and when it starts again (ms). */
export interface LimitWindow {
  /** "5h", "Week" */
  label: string;
  percent: number;
  resetsAt: number | null;
}
/** A plan's limits, for the sidebar. ready: false when it isn't installed or signed in (why says which). */
export interface ProviderLimits {
  ready: boolean;
  why?: string;
  /** e.g. "pro", "plus" (Codex says) */
  plan?: string | null;
  windows: LimitWindow[];
  /** Codex says you can't use the plan's own usage right now */
  blocked?: boolean;
}
/** Free Codex limit resets on your account; credits: the ones Codex listed, the one that runs out first first. */
export interface CodexResets {
  available: number;
  credits: { id: string; expiresAt: number | null; title: string | null }[];
}
/** GET /api/usage-limits */
export interface UsageLimits {
  claude: ProviderLimits;
  codex: ProviderLimits & { resets: CodexResets | null };
}
/** POST /api/codex/reset */
export interface CodexResetResult {
  outcome: 'reset' | 'nothingToReset' | 'noCredit' | 'alreadyRedeemed';
  limits: UsageLimits;
}

/** GET /api/about: which Athena Agents this is and where it lives on GitHub. */
export interface AboutInfo {
  name: string;
  version: string;
  /** "owner/name" on GitHub */
  repo: string;
  url: string;
  license: string;
  /** GitHub stars, when asked for (?stars=1) and GitHub answered; null otherwise (e.g. a private repo) */
  stars: number | null;
}

// ---------- ComfyUI and programs on this PC (server/comfyui.ts, server/programs.ts) ----------
/** A file in a /history entry's outputs. */
export interface ComfyOutputFile {
  filename: string;
  subfolder?: string;
  type?: string;
  [k: string]: unknown;
}

/** An output file with its kind ('images', 'gifs', 'videos', 'audio', '3d') and a dashboard URL to view it. */
export type ComfyResultFile = ComfyOutputFile & { kind: string; url: string };

/** What POST /prompt says about a node that failed its checks (its node_errors). */
export interface ComfyNodeError {
  class_type?: string;
  dependent_outputs?: string[];
  errors?: { type?: string; message?: string; details?: string; extra_info?: { input_name?: string } }[];
}

/** One file a run sent to ComfyUI: the name ComfyUI gave it, and the input it was set on ("10.image"). */
export interface ComfyUploaded {
  file: string;
  mask?: string;
  value: string;
  input: string;
}

/** A seed a run used, per node (a sampler's seed, a RandomNoise node's noise_seed). */
export interface ComfySeed {
  node: string;
  title: string;
  input: string;
  value: number;
}

export interface RunWorkflowQueued {
  promptId: string;
  queued: true;
  seeds: ComfySeed[];
  warnings: string[];
  uploaded: ComfyUploaded[];
  nodeErrors: Record<string, ComfyNodeError>;
}

export interface RunWorkflowDone {
  promptId: string;
  workflow: string;
  files: ComfyResultFile[];
  seconds: number;
  seeds: ComfySeed[];
  warnings: string[];
  uploaded: ComfyUploaded[];
  /** Nodes ComfyUI left out because they failed its checks, with the outputs that needed them. */
  nodeErrors: Record<string, ComfyNodeError>;
}

export interface ComfyQueueStatus {
  running: boolean;
  url?: string;
  queueRunning?: number;
  queuePending?: number;
  devices?: { name: string; vramFreeGB: number; vramTotalGB: number }[];
  version?: string | null;
}

/** Where a workflow's prompts are: the first text node of each, and every input prompt and negative replace. */
export interface PromptNodes {
  positive: string | null;
  negative: string | null;
  /** "nodeId.input" keys the prompt goes into (SDXL's text_g and text_l, Flux's clip_l and t5xxl…). */
  promptInputs: string[];
  negativeInputs: string[];
  /** text mixed in beside the prompt (a combined conditioning's other branches): left as saved by a new prompt */
  promptAlso?: string[];
  negativeAlso?: string[];
}

/** A Start Menu shortcut. folder is relative to the Start Menu's Programs folder. */
export interface StartMenuApp {
  name: string;
  shortcut: string;
  folder: string;
}

/** A known program as discoverPrograms() reports it. */
export interface Program {
  id: string;
  name: string;
  category: string;
  installed: boolean;
  optional: boolean;
  exe: string | null;
  shortcut: string | null;
  version: string | null;
  versions: string[] | null;
  cli: boolean;
  running: boolean;
  serviceUrl: string | null;
  actions: string[];
}

// ---------- what this file returns ----------
export interface BrainModel {
  provider: BrainSetting['provider'];
  model: string;
  /** for this provider ('' = the model's default) */
  effort: Effort | '';
  fallback: boolean;
}

export type BrainRoute =
  { kind: 'none'; reason: string } | { kind: 'agent' | 'branch'; id: string; name: string; reason: string };

/** A new agent the Brain designed (not saved yet). */
export type AgentDraft = Pick<
  Agent,
  'name' | 'emoji' | 'specialty' | 'systemPrompt' | 'toolGroups' | 'mcpServers' | 'engine'
>;

export type BranchMember = { agentId: string; newAgent?: undefined } | { newAgent: AgentDraft; agentId?: undefined };

/** A team the Brain designed. leadIndex points into members (-1 = no lead). */
export interface BranchDesign {
  name: string;
  description: string;
  access: TeamAccess;
  members: BranchMember[];
  leadIndex: number;
}

// ---------- Skills from plain words ----------
/** A skill the Brain wrote or changed from your words (not saved: you look it over first). */
export interface SkillDraft {
  name: string;
  description: string;
  body: string;
  /** One sentence: what it wrote or changed */
  note: string;
}

/** A backup file in the backups folder. */
export interface BackupListing {
  name: string;
  size: number;
  modifiedAt: number;
  summary: BackupSummary | null;
}

export type FileKind = 'image' | 'video' | 'audio' | 'model' | 'file' | 'folder';

/** What a chat needs to preview a mentioned path. ok: false when it isn't there or isn't allowed. */
export type FileInfo =
  | { path: string; ok: false }
  | { path: string; ok: true; kind: FileKind; name: string; size: number; modified: number };

/** Where things sit on the Station map that aren't teams (data/projects/<id>/layout.json). */
export interface StationLayout {
  /** the bench of agents on no team; null: its own place */
  bench?: { x: number; z: number } | null;
}

// ---------- MCP servers (server/mcp.ts) ----------
/** One saved MCP server (data/mcp.json). */
export interface McpServerConfig {
  type: 'stdio' | 'http' | string;
  command: string;
  args: string[];
  env: Record<string, string>;
  url: string;
  headers: Record<string, string>;
  description: string;
  enabled: boolean;
  /** This copy's own name ("Work", "Client A"), for a service added more than once (several accounts). */
  label?: string;
  /** The service it is, when not worked out on its own (see kindOf): a ready-made server's name, or another server's kind. */
  kind?: string;
  /** When to pick this copy over the service's other ones: for the Brain, and the agent that has it. */
  useFor?: string;
}
export type McpServers = Record<string, McpServerConfig>;

/** What saveServer() accepts: a form body, a preset or an importable server. args may be one string. */
export interface McpServerInput {
  type?: string;
  command?: string;
  args?: string[] | string;
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  description?: string;
  enabled?: boolean;
  label?: string;
  kind?: string;
  useFor?: string;
}

export type McpPreset = {
  name: string;
  title: string;
  description: string;
  /** What to do outside the dashboard before it works (an editor plugin, a program), for the Brain to pass on. */
  setup?: string;
  /** The host every link of this service is on, when each account gets its own link (Composio) */
  host?: string;
} & (
  | { type: 'stdio'; command: string; args: string[]; env?: Record<string, string> }
  | { type: 'http'; url: string; headers: Record<string, string> }
);

export interface ImportableServer {
  source: string;
  name: string;
  type: 'http' | 'stdio';
  command?: string;
  args: string[];
  env: Record<string, string>;
  url?: string;
  headers: Record<string, string>;
}

export interface BridgeServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}
/** A ready-made server as GET /api/mcp lists it: whether its command is on this PC, and whether it is added (and as
 *  which servers). */
export type McpPresetListing = McpPreset & { service: string; ready: boolean; installed: boolean; copies: string[] };

/** GET /api/mcp: the servers (keys and logins hidden), the ready-made ones, what fits this PC, what a Claude config
 *  has to import, and the bridge (its token hidden: POST /api/mcp-bridge gives it to copy). */
export interface McpOverview {
  servers: McpServers;
  info: Record<string, McpServerInfo>;
  presets: McpPresetListing[];
  suggested: McpSuggestion[];
  importable: ImportableServer[];
  bridge: BridgeServerConfig;
}

/** An MCP server as the page shows it: a service can be added more than once (several accounts), each copy with a label. */
export interface McpServerInfo {
  /** "OOMOL: Work" for a copy with a label, else the server's name */
  title: string;
  label: string;
  /** the service it is (a ready-made server's name, or its own name) */
  kind: string;
  /** the service for people ("OOMOL") */
  service: string;
  /** when to pick this copy over the service's other ones */
  useFor: string;
  /** how many servers of this service there are (1: added once) */
  copies: number;
}

/** A ready-made MCP server worth adding on this PC (GET /api/mcp "suggested"): never added on its own. */
export interface McpSuggestion {
  name: string;
  title: string;
  description: string;
  /** why: "Blender is installed", or "useful to most agents, no key or setup" */
  reason: string;
  /** what it needs from you first (a key, a setup step in the program), '' when nothing */
  needs: string;
  /** the Programs page id of the program it drives, null for the basics */
  program: string | null;
}

// ---------- the voxel world (docs/internal/plans/VOXEL_WORLD_PLAN.md) ----------
/** How a voxel material is drawn: solid ones block light and hide what is behind them, glass and water don't. */
export type VoxelMaterialKind = 'solid' | 'glass' | 'water' | 'emissive' | 'metal' | 'leaf' | 'snow';

/** One entry of a world's palette. A voxel's value v (1..255) is palette[v - 1]; 0 is empty. */
export interface VoxelMaterial {
  name: string;
  /** #rrggbb */
  color: string;
  /** extra shades (#rrggbb) a voxel may take instead of color, picked per voxel */
  ramp?: string[];
  /** 0..0.3: how much each voxel's brightness varies */
  jitter?: number;
  kind: VoxelMaterialKind;
  /** emissive: how bright it glows, 0..8 */
  emissive?: number;
  /** glass and water: 0..1 */
  opacity?: number;
  roughness?: number;
}

export type WorldEnvPreset = 'station' | 'day' | 'golden' | 'dusk' | 'night' | 'overcast' | 'snow';

/** Where a light or an effect is: pinned like an object (anchor), or to an object (it moves and turns with it). */
interface WorldPlaced {
  id: string;
  name: string;
  by: WorldBuilder;
  anchor: WorldAnchor;
  /** an object's id: then position is from that object's origin, and it turns with it */
  object?: string;
  /** map units */
  position: Vec3;
}

/** A light a builder put up. */
export interface WorldLight extends WorldPlaced {
  kind: 'point' | 'spot';
  color: string;
  /** 0..10: 1 is a lantern, 4 a street lamp, 10 a floodlight */
  intensity: number;
  /** how far it reaches, map units */
  range: number;
  /** spot: the point it shines at (same frame as position) and the cone's angle in degrees */
  target?: Vec3;
  angle?: number;
  /** 0..1: how much it flickers (a flame, a failing neon) */
  flicker?: number;
}

export type WorldEffectKind =
  | 'petals'
  | 'leaves'
  | 'snow'
  | 'rain'
  | 'fireflies'
  | 'embers'
  | 'sparks'
  | 'smoke'
  | 'steam'
  | 'mist'
  | 'dust'
  | 'birds';

/** Particles in an area. */
export interface WorldEffect extends WorldPlaced {
  kind: WorldEffectKind;
  /** the area's size around position (w, h, d map units); position is its bottom centre */
  size: Vec3;
  /** 0..1: how many */
  amount: number;
  /** colours to pick from (#rrggbb); each kind has its own when left out */
  colors?: string[];
  /** which way and how hard it blows (map units a second) */
  wind?: Vec3;
}

/** Sky, fog, sun and the finishing touches of a world's look. Colors are #rrggbb, angles in degrees. */
export interface WorldEnvironment {
  preset: WorldEnvPreset;
  sky: { top: string; horizon: string; bottom: string };
  /** density 0..1 (0: no fog) */
  fog: { color: string; density: number };
  sun: { color: string; intensity: number; azimuth: number; elevation: number };
  ambient: { sky: string; ground: string; intensity: number };
  /** 0..2 glow around bright things */
  bloom: number;
  /** 0..1 miniature blur at the top and bottom of the view */
  tiltShift: number;
  exposure: number;
  /** weather over the whole map (besides effects in areas) */
  weather?: 'none' | 'snow' | 'rain' | 'petals' | 'leaves' | 'dust';
  /** wind for leaves, petals, snow and the sway of leaves (map units a second) */
  wind?: Vec3;
}

export type Vec3 = [number, number, number];

/** What an object is pinned to. It moves with that thing (a team dragged across the map). */
export type WorldAnchor = { to: 'world' } | { to: 'brain' } | { to: 'team'; id: string } | { to: 'agent'; id: string };

/** Who built or last changed something in a world. */
export interface WorldBuilder {
  kind: 'brain' | 'agent' | 'user';
  id?: string;
  name: string;
}

/** One grid of an object: all its voxels have one size. Voxel (x, y, z) sits at object origin + (x, y, z) × voxelSize. */
export interface VoxelVolumeMeta {
  id: string;
  voxelSize: number;
  /** voxels in it */
  count: number;
  /** the voxels it spans, inclusive (null when empty) */
  min: Vec3 | null;
  max: Vec3 | null;
}

export interface VoxelObjectMeta {
  id: string;
  name: string;
  by: WorldBuilder;
  /** who changed it last (may differ from who built it) */
  lastBy?: WorldBuilder;
  anchor: WorldAnchor;
  /** map units, from its anchor */
  position: Vec3;
  /** degrees, around the vertical */
  rotation: number;
  scale: number;
  volumes: VoxelVolumeMeta[];
  hidden?: boolean;
  /** where it last stood on the map: used when its anchor isn't in the project showing it */
  lastWorldPos?: Vec3;
  createdAt: number;
  updatedAt: number;
  /** when its voxels last changed (a move doesn't count): the page meshes it again */
  voxelsAt?: number;
  /** how many prefab copies are placed in it */
  instances?: number;
}

/** A prefab copy placed in an object (or in another prefab). Not voxels: the page repeats the prefab's mesh. */
export interface PrefabInstance {
  /** the prefab's id */
  prefab: string;
  /** where its pivot (bottom centre) stands, in map units from the object's origin */
  p: Vec3;
  /** degrees around the vertical, any angle */
  turn?: number;
  /** quarter turns around x (tilt) and z (roll): 0, 90, 180 or 270 */
  tilt?: number;
  roll?: number;
  scale?: number;
  /** mirrored left to right (across its own x) */
  mirror?: boolean;
  /** materials swapped in this copy: { "shirt": "cloth red" } */
  swap?: Record<string, string>;
  /** a part's name inside a character ("left arm"): animations move it by this name */
  name?: string;
}

/** One moment of a part in an animation. Turns are degrees around the part's own pivot (x, y, z); moves are map units. */
export interface AnimKey {
  /** when, from 0 (start) to 1 (end of the clip) */
  t: number;
  turn?: Vec3;
  move?: Vec3;
  scale?: number;
  /** how it gets here from the key before */
  ease?: 'linear' | 'smooth' | 'step' | 'bounce';
}

/** An animation a builder designed for a character prefab: keys per part ("self" moves the whole character). */
export interface AnimationClip {
  /** seconds */
  duration: number;
  loop: boolean;
  tracks: Record<string, AnimKey[]>;
}

/** An object's or a prefab's voxels (…/objects/<id>.json, …/prefabs/<id>.json): chunks run-length encoded
 *  (shared/voxel.ts), and the prefab copies placed in it. */
export interface VoxelObjectData {
  volumes: { id: string; voxelSize: number; chunks: Record<string, string> }[];
  instances?: PrefabInstance[];
}

/** A small model an agent made to place many times (a palm, a person, a taxi). Its voxels use the world's palette. */
export interface VoxelPrefabMeta {
  id: string;
  name: string;
  description: string;
  tags: string[];
  by: WorldBuilder;
  lastBy?: WorldBuilder;
  volumes: VoxelVolumeMeta[];
  /** prefab copies placed inside it */
  instances?: number;
  /** map units from its voxels' origin to the point that stands on the spot it is placed at (bottom centre,
   *  unless the builder chose another: a top pivot for an arm that hangs from a shoulder) */
  pivot: Vec3;
  /** the pivot the builder chose; missing = bottom centre */
  pivotAt?: 'bottom' | 'top' | 'center' | Vec3;
  /** animations its builder designed (for characters made of named parts) */
  animations?: Record<string, AnimationClip>;
  /** how big it is, map units */
  size: Vec3;
  createdAt: number;
  updatedAt: number;
  voxelsAt?: number;
}

/** A voxel world (data/worlds/<id>/world.json). Projects point at one (ProjectWorldLink). */
export interface VoxelWorld {
  format: 1;
  id: string;
  name: string;
  /** the project it was first made for */
  homeProject: string;
  /** false until something is built in it: an unbuilt world can be replaced by a carried-over one */
  built: boolean;
  /** the voxel size new objects start with, in map units (a desk is 2.6 wide) */
  voxelSize: number;
  palette: VoxelMaterial[];
  objects: VoxelObjectMeta[];
  /** the prefabs its builders made */
  prefabs: VoxelPrefabMeta[];
  /** lights builders put up (glowing voxels light their surroundings by themselves too) */
  lights: WorldLight[];
  /** particles: falling petals, snow, fireflies, smoke… */
  effects: WorldEffect[];
  /** how the Brain, the team platforms and the agents look in this world (voxel look only) */
  skins: WorldSkins;
  environment: WorldEnvironment;
  createdAt: number;
  updatedAt: number;
}

/** Which world a project uses. */
export interface ProjectWorldLink {
  id: string;
  /** own: made for this project. shared: another project's world; changes show in both. */
  mode: 'own' | 'shared';
  /** the user picked it: carry-over never replaces their choice */
  chosen?: boolean;
}

/** The world a project shows (GET /api/world), and why. */
export interface ShownWorld {
  world: VoxelWorld | null;
  /** own, shared, carried over from another project, or none built anywhere */
  how: 'own' | 'shared' | 'carried' | 'none';
  /** for a carried-over or shared world: the project it was made for */
  fromProject?: string;
}

// ---------- the prefab library ----------
/** A prefab shared to every world: its voxels use its own small palette. */
export interface LibraryPrefab {
  id: string;
  name: string;
  description: string;
  tags: string[];
  by: string;
  /** who published it (entries published before this was kept have only the name) */
  builder?: WorldBuilder;
  fromWorld: string;
  size: Vec3;
  voxels: number;
  palette: VoxelMaterial[];
  data: VoxelObjectData;
  /** the point copies stand on and turn around, as its builder chose it (missing: bottom centre) */
  pivotAt?: VoxelPrefabMeta['pivotAt'];
  animations?: Record<string, AnimationClip>;
  createdAt: number;
}

/** A prefab in the shared library as it is listed (GET /api/prefab-library): without its voxels. */
export type LibraryPrefabListing = Omit<LibraryPrefab, 'data' | 'palette'>;

/** An earlier WORLD.md, as its list shows it (chars: how long) and as one is read (item). */
export interface WorldMdVersionEntry {
  id: string;
  at: number;
  by: string;
  note?: string;
  chars: number;
}
export interface WorldMdVersion {
  id: string;
  at: number;
  by: string;
  note?: string;
  item: { text: string };
}

/** A world in the list of worlds (GET /api/worlds). */
export interface WorldListing {
  id: string;
  name: string;
  homeProject: string;
  built: boolean;
  objects: number;
  voxels: number;
  /** projects that use it */
  usedBy: string[];
  isDefault: boolean;
  updatedAt: number;
}

/** A world's WORLD.md (GET /api/world/md). */
export interface WorldMdInfo {
  worldId: string;
  text: string;
  updatedAt: number;
  max: number;
}

/** The fields every skin has: where its model sits from the classic one, turned and scaled. */
interface SkinPlacement {
  /** map units from where the classic model stands */
  offset?: Vec3;
  /** degrees around the vertical */
  turn?: number;
  scale?: number;
  /** take it off the map (the Station still works: click its name, or use the side panel) */
  hidden?: boolean;
  /** false: no name label on the map either */
  label?: boolean;
  /** who dressed it last */
  by?: WorldBuilder;
}

/** An agent in the voxel world: its character, its desk, and which animation plays when. */
export interface AgentSkin extends SkinPlacement {
  /** a prefab (id) made of named parts; it takes the classic person's place */
  character?: string;
  /** a prefab (id) that takes the classic desk's place (the monitor's screen stays) */
  desk?: string;
  /** the character's animation for each state (default: clips named idle, working, needs) */
  states?: { idle?: string; working?: string; needs?: string };
}

/** A team's platform and the hub in its middle. */
export interface TeamSkin extends SkinPlacement {
  platform?: string;
  hub?: string;
}

/** The Brain: a shell around (or instead of) the globe. */
export interface BrainSkin extends SkinPlacement {
  shell?: string;
  /** keep the particle globe, the beam and the halo (default true) */
  globe?: boolean;
}

export interface WorldSkins {
  brain?: BrainSkin;
  /** by team id */
  teams: Record<string, TeamSkin>;
  /** by agent id */
  agents: Record<string, AgentSkin>;
}

/** What a world_look picture shows (the 'world-look' event the Station answers). */
export interface WorldLookView {
  /** the whole world, or one thing in it */
  target: 'overview' | 'brain' | 'team' | 'agent' | 'object' | 'prefab';
  /** the team's, agent's, object's or prefab's id */
  id?: string;
  /** degrees; the Station's own view is azimuth 45, elevation 35 */
  azimuth?: number;
  elevation?: number;
  /** 1 fits the target; 2 is twice as close */
  zoom?: number;
  width: number;
  height: number;
}

// ---------- the scene look ----------
/** Who changed a scene: an agent or the Brain (with its run), the user going back, a backup, or something outside
 *  Athena (an editor, or an agent's own file tools while more than one run was going on). */
export interface SceneAuthor {
  kind: 'agent' | 'brain' | 'user' | 'outside' | 'backup';
  id?: string;
  name?: string;
  runId?: string;
}
/** One kept version of a project's scene (server/scene/history.ts): its files, by path inside the scene folder. */
export interface SceneVersion {
  id: string;
  at: number;
  by: SceneAuthor;
  /** "Restored the version from 3:05 pm", "Changed while Athena was closed" */
  note?: string;
  files: Record<string, { hash: string; size: number }>;
  /** how it loaded in the Station; missing: not loaded yet */
  loads?: 'ok' | 'broken';
  /** the first error, when it doesn't load */
  error?: string;
  pinned?: boolean;
  /** a small picture of it was kept (the first tab it loaded in made one) */
  thumb?: boolean;
}
/** A project's scene versions, newest first, and what the Station should show. */
export interface SceneVersions {
  versions: SceneVersion[];
  /** the newest version (null: the project has no scene) */
  newest: string | null;
  /** the newest version that loads (null: none has loaded yet) */
  newestGood: string | null;
  /** the project has a scene folder now (false: the Station shows the starter; the versions are still there) */
  present: boolean;
  /** why the folder's latest state isn't a version (over the limits, no index.html…), or null */
  problem: string | null;
}
