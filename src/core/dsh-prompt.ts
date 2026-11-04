// DSH's assembled system prompt as the head of the RWKV system block
// (names: 'dsh'). DSH joins its sections with blank lines; the Standard
// prompt carries ten that describe tools and surfaces the RWKV preset does not
// mount, and two of them (checkout path, Web GUI) are registered globally, so
// they reach every preset. Those are dropped by their opening words; the rest
// (persona, @paths, bash exit code, read/write/edit/glob/grep, web) is kept
// verbatim.

/** Opening words of the Standard sections the RWKV preset does not use. */
export const DROPPED_SECTION_OPENERS: readonly string[] = [
  'Prefer apply_patch over separate edit calls', // apply_patch
  'Track every background job id you start.', // background jobs
  'create_goal may infer goal intent', // goal
  'Only create or modify scheduled tasks', // schedule
  'Use the workflow tool ONLY', // workflow
  'Start independent delegations with `subagent`', // subagent
  'Agents may use different working directories;', // subagent: shared files
  'Prefer showing the primary results within your final response', // present
  'The runtime context names the DeepSeek Harness implementation checkout.', // DSH checkout path
  'You are interacting with the user through the DeepSeek Harness Web GUI', // Web GUI
]

/** The DSH system prompt without the dropped sections; '' when nothing is left. */
export function dshSystemSections(system: string): string {
  return system
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(section => section.trim())
    .filter(section => section !== '' && !DROPPED_SECTION_OPENERS.some(opener => section.startsWith(opener)))
    .join('\n\n')
}
