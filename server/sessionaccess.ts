// Who may use session search (Settings › Session search). Kept apart from sessions.ts so the tool list can ask
// without loading the teams and chats it reads.
import { getSettings } from './store.ts';
import { isGatewayConversation } from './private-conversations.ts';

export const sessionSearchOn = (): boolean => getSettings().sessionSearch === true;

/** May a run in this conversation search sessions: the setting is on, and it isn't a gateway conversation
 *  (someone writing in from outside must not read the project's sessions through it). */
export const sessionSearchFor = (conversationId: string | null | undefined): boolean =>
  sessionSearchOn() && !isGatewayConversation(conversationId);
