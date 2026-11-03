// The project a chat belongs to when it may not be the open one (an Overview pane): its file links, tool images
// and questions are that project's. Undefined: the open project's.
import { createContext } from 'react';

export const ChatProject = createContext<string | undefined>(undefined);
