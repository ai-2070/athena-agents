// Prints the oRPC contract's routes (paths and methods, no schemas) as JSON: what the page's bundle gets in place
// of shared/api/index.ts (build-web.ts), so the page doesn't load zod for checks only the server makes.
import { minifyContractRouter } from '@orpc/contract';
import { contract } from '../shared/api/index.ts';

process.stdout.write(JSON.stringify(minifyContractRouter(contract)));
