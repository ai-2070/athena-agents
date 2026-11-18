// Raised with every Eve update (tests/server/eve-version.test.ts checks): sessions an older Eve made are retired on
// start, since a newer Eve may not take messages on them. Agents start fresh sessions with their chats.
export const EVE_GENERATION = 'eve-1.0.2-athena-4';
