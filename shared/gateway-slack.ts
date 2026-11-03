/** Slack timestamps are opaque IDs; converting them to numbers loses message identity. */
export const slackTimestamp = /^[1-9]\d{0,15}\.\d{6}$/;
export const slackWorkspaceId = /^T[A-Z0-9]+$/;
export const slackUserId = /^[UW][A-Z0-9]+$/;
export const slackChannelId = /^[CDG][A-Z0-9]+$/;
