// The one gateway supervisor the server runs (server/index.ts starts it). Here, so the routes in server/api/ can ask
// it too. Making it starts nothing.
import { GatewaySupervisor } from './supervisor.ts';

export const gatewaySupervisor = new GatewaySupervisor();
