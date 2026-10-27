// Generators: a few parameters in, thousands of voxels out (a tree, an island…). Sizes are in map units
// (a desk is 2.6 wide, a person 1.7 tall), so the voxel size only changes how fine the result is.
import type { GeneratorDef } from '../ops.ts';
import { bridge } from './bridge.ts';
import { cloud } from './cloud.ts';
import { island } from './island.ts';
import { lantern } from './lantern.ts';
import { rock } from './rock.ts';
import { torii } from './torii.ts';
import { tree } from './tree.ts';

export const GENERATORS: Record<string, GeneratorDef> = { tree, rock, island, cloud, bridge, torii, lantern };
