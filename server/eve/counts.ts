/** How often Eve did its costlier work. Only tests read these, to prove the caches hold. */
export const eveCounts = { promptBuilds: 0, toolLists: 0, contexts: 0, runReads: 0, operationReads: 0 };

export function resetEveCounts(): void {
  for (const key of Object.keys(eveCounts) as (keyof typeof eveCounts)[]) eveCounts[key] = 0;
}
